import { skillId } from '@gemwright/common/skills';

import { canSpendOnTraining, chargedPurchase, recordTrainingSpend } from './bank-gold';
import { atVendor, type CraftContext } from './craft-training';
import { packItems } from './inventory';

const book = 0x0efa;
const [garlic, ginseng, mandrake, nightshade, silk, ash, moss] = [
  0x0f84, 0x0f85, 0x0f86, 0x0f88, 0x0f8d, 0x0f8c, 0x0f7b
];
// Regular spell scrolls (Loot.RegularScrollTypes): Reactive Armor 0x1F2D, then 0x1F2E onwards.
export const isSpellScroll = (graphic: number) => graphic >= 0x1f2d && graphic <= 0x1f6c;
// Self-cast spells from the circles SBMage sells scrolls for (1-3). ServUO MagerySpell gains from
// 14.3 * (circle - 1) - 20 up to 40 points higher; mana per circle 4, 6, 9.
const spells = [
  { id: 4, name: 'Heal', circle: 1, scroll: 0x1f31, mana: 4, reagents: [garlic, ginseng, silk] },
  { id: 10, name: 'Cunning', circle: 2, scroll: 0x1f36, mana: 6, reagents: [mandrake, nightshade] },
  { id: 17, name: 'Bless', circle: 3, scroll: 0x1f3d, mana: 9, reagents: [garlic, mandrake] },
  // Circles 4-6 come only from looted scrolls; skipped while not in the book.
  { id: 26, name: 'Arch Protection', circle: 4, scroll: 0x1f47, mana: 11, reagents: [garlic, ginseng, mandrake, ash] },
  {
    id: 36,
    name: 'Magic Reflection',
    circle: 5,
    scroll: 0x1f51,
    mana: 14,
    reagents: [garlic, mandrake, silk],
    untargeted: true
  },
  { id: 48, name: 'Reveal', circle: 6, scroll: 0x1f5d, mana: 20, reagents: [moss, ash] }
];
const VENDOR_CIRCLES = 3;
const NO_SPELL = 500015; // You do not have that spell!
const NO_MANA = 502625;
const NO_REAGENTS = 502630;
const FIZZLE = 502632;

export type MageryContext = CraftContext & { backpack: () => number };

// Buys up to `amount` of each wanted graphic from the mage in one visit.
export async function shop(ctx: MageryContext, wanted: Map<number, number>, budget: number) {
  const { session } = ctx;
  return atVendor(ctx, 'mage', 3006103, async (vendor) => {
    const before = session.world.received.get(0x74) ?? 0;
    session.world.buyOffers.clear();
    const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006103);
    if (!entry) return false;
    session.selectContext(vendor, entry.index);
    await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'mage stock', 2500).catch(() => {});
    let bought = false;
    for (const offer of [...session.world.buyOffers.values()].flat()) {
      const graphic = session.world.entities.get(offer.serial)?.graphic ?? 0;
      const amount = Math.min(wanted.get(graphic) ?? 0, Math.floor(budget / Math.max(1, offer.price)));
      if (amount < 1 || offer.price > 25) continue;
      if (!canSpendOnTraining(session, ctx.backpack(), ctx.checkpoint, amount * offer.price)) continue;
      await chargedPurchase(ctx, amount * offer.price, () =>
        session.purchaseItem(vendor, offer.serial, ctx.backpack(), amount, amount * offer.price)
      );
      recordTrainingSpend(ctx.checkpoint, amount * offer.price);
      budget -= amount * offer.price;
      bought = true;
    }
    return bought;
  });
}

// Practises Magery until `until` by self-casting the highest useful vendor spell; meditates for mana.
export async function trainMagery(ctx: MageryContext, until: number) {
  const { session, carried, check, phase, log, status } = ctx;
  const skill = () => session.world.skills.get(skillId('Magery'))?.base ?? 0;
  const count = (graphic: number) =>
    carried(ctx.backpack())
      .filter((item) => item.graphic === graphic)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const missing = new Set<number>();
  const spell = () =>
    [...spells]
      .reverse()
      .find((s) => !missing.has(s.id) && skill() >= 14.3 * (s.circle - 1) - 20 && skill() < 14.3 * (s.circle - 1) + 20);
  if (!spell()) return 0;
  // A trip to the mage only when the training budget can pay for what is missing (bank-gold.ts):
  // a poor resident does not walk across the map to be refused.
  const affords = (cost: number) => canSpendOnTraining(session, ctx.backpack(), ctx.checkpoint, cost);
  const short = spell()?.reagents.some((r) => count(r) < 5) ?? false;
  if ((!count(book) && !affords(30)) || (short && !affords(60))) return 0;
  if (!count(book) && !(await shop(ctx, new Map([[book, 1]]), 30))) return 0;
  // Looted scrolls go into the book first; duplicates stay in the pack for sale.
  const spellbook = () => carried(ctx.backpack()).find((item) => item.graphic === book);
  for (const scroll of carried(ctx.backpack()).filter((item) => isSpellScroll(item.graphic))) {
    const target = spellbook();
    if (!target) break;
    await session.moveItem(scroll.serial, target.serial).catch(() => {});
    if (!session.world.entities.has(scroll.serial))
      log(`Added a looted spell (scroll ${scroll.graphic.toString(16)}) to the spellbook`);
  }
  let casts = 0;
  phase('training', 'Practising Magery on myself');
  while (Date.now() < until) {
    check();
    const current = spell();
    if (!current) break;
    if (current.reagents.some((r) => count(r) < 5)) {
      const wanted = new Map(current.reagents.map((r) => [r, 90]));
      if (!(await shop(ctx, wanted, 200))) break;
      continue;
    }
    if (status().mana < current.mana) {
      // Active Meditation (skill 46) speeds mana regeneration while standing still.
      phase('meditating', 'Meditating to recover mana');
      if (!session.world.target) session.useSkill(skillId('Meditation'));
      const wake = Math.min(until, Date.now() + 60_000);
      while (Date.now() < wake && status().mana < status().maxMana * 0.9) {
        check();
        await Bun.sleep(3000);
        await session.refreshStatus();
      }
      continue;
    }
    const seen = new Set(session.world.journal);
    const reply = () => session.world.journal.find((e) => !seen.has(e) && e.cliloc !== undefined)?.cliloc;
    session.useSkill(current.id, true);
    await session
      .waitFor(
        () => session.world.target !== null || [NO_SPELL, NO_MANA, NO_REAGENTS, FIZZLE].includes(reply() ?? 0),
        'spell cursor',
        5000
      )
      .catch(() => {});
    if (session.world.target) {
      session.target({ serial: ctx.serial, x: 0, y: 0, z: 0, graphic: 0 });
      casts++;
    } else if ('untargeted' in current && reply() === undefined) {
      casts++;
    } else if (reply() === NO_SPELL) {
      // Scrolls dropped on the book are absorbed into it (Spellbook.OnDragDrop). Vendors sell
      // circles 1-3; higher circles wait for a looted scroll.
      const buyable = current.circle <= VENDOR_CIRCLES;
      if (!count(current.scroll) && (!buyable || !(await shop(ctx, new Map([[current.scroll, 1]]), 40)))) {
        missing.add(current.id);
        continue;
      }
      const scroll = carried(ctx.backpack()).find((item) => item.graphic === current.scroll);
      const spellbook = carried(ctx.backpack()).find((item) => item.graphic === book);
      if (!scroll || !spellbook) break;
      await session.moveItem(scroll.serial, spellbook.serial).catch(() => {});
      if (session.world.entities.has(scroll.serial)) break;
      log(`Added ${current.name} to the spellbook`);
    }
    await Bun.sleep(1200 + Math.random() * 400);
    await session.refreshStatus();
  }
  log(`Practised Magery ${casts} times`);
  return casts;
}

// Vendor scroll ids (SBMage, circles 1-3) for the combat spells casters fight with.
const combatScrolls = new Map([
  [5, 0x1f32],
  [4, 0x1f31],
  [12, 0x1f38],
  [11, 0x1f37],
  [20, 0x1f40],
  [18, 0x1f3e],
  [17, 0x1f3d]
]);

// Gives a caster a spellbook holding its vendor-sold combat spells. Each spell is tried at most once
// a day, and only until it is known to be in the book (kept with the resident, so restarts do not
// repeat it): a cast answered with "You do not have that spell!" decides whether to buy its scroll.
export async function prepareSpellbook(ctx: MageryContext) {
  const { session } = ctx;
  ctx.checkpoint.spells ??= { checked: 0, has: [] };
  const spells = ctx.checkpoint.spells;
  if (spells.checked > Date.now() - 24 * 3_600_000) return;
  spells.checked = Date.now();
  // A book in hand or in a bag counts: a caster never buys a second one.
  const ownsBook = () =>
    packItems(session, ctx.backpack()).some((item) => item.graphic === book) ||
    session.world.childrenOf(session.world.serial ?? -1).some((item) => item.graphic === book);
  // A new book starts empty.
  if (!ownsBook()) spells.has = [];
  if (!ownsBook() && !(await shop(ctx, new Map([[book, 1]]), 30))) return;
  for (const [id, scroll] of combatScrolls) {
    if (session.world.target) break;
    await ensureSpell(ctx, id, scroll);
  }
}

// Puts one spell in the book: tried by casting once (and the cursor dropped), its scroll bought
// from the mage only when the server answers "You do not have that spell!". True when it is in.
export async function ensureSpell(ctx: MageryContext, id: number, scroll: number): Promise<boolean> {
  const { session, carried } = ctx;
  ctx.checkpoint.spells ??= { checked: 0, has: [] };
  const spells = ctx.checkpoint.spells;
  if (spells.has.includes(id)) return true;
  if (session.world.target) return false;
  const seen = new Set(session.world.journal);
  session.useSkill(id, true);
  await Bun.sleep(1500);
  if (session.world.target) session.target(null);
  if (!session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL)) {
    spells.has.push(id);
    return true;
  }
  const has = () => carried(ctx.backpack()).some((item) => item.graphic === scroll);
  if (!has() && !(await shop(ctx, new Map([[scroll, 1]]), 40))) return false;
  const item = carried(ctx.backpack()).find((i) => i.graphic === scroll);
  const target = carried(ctx.backpack()).find((i) => i.graphic === book);
  if (item && target) await session.moveItem(item.serial, target.serial).catch(() => {});
  if (item && !session.world.entities.has(item.serial)) spells.has.push(id);
  return spells.has.includes(id);
}
