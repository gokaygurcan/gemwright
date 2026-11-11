import { spellbook } from '@gemwright/common/game/items';
import { spellScrollGraphics } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { Actions, ShardMessage } from '@gemwright/network/replies';

import { canSpendOnTraining, chargedPurchase, recordTrainingSpend } from './bank-gold';
import type { CraftContext } from './craft-training';
import { packItems } from './inventory';
import { spellNamed as rule } from './spell-rules';
import { buyOffers } from './vendor-shop';
import { atVendor } from './vendor-visit';

const spellNamed = (name: string, untargeted?: true) => ({ ...rule(name), ...(untargeted && { untargeted }) });
export const isSpellScroll = (graphic: number) => spellScrollGraphics.has(graphic);
// Self-cast spells from the circles SBMage sells scrolls for (1-3). ServUO MagerySpell gains from
// 14.3 * (circle - 1) - 20 up to 40 points higher.
const spells = [
  spellNamed('Heal'),
  spellNamed('Cunning'),
  spellNamed('Bless'),
  // Circles 4-6 come only from looted scrolls; skipped while not in the spellbook.
  spellNamed('Arch Protection'),
  spellNamed('Magic Reflection', true),
  spellNamed('Reveal')
];
const VENDOR_CIRCLES = 3;
const NO_SPELL = ShardMessage.noSuchSpell; // You do not have that spell!
const NO_MANA = 502625;
const NO_REAGENTS = 502630;
const FIZZLE = 502632;

export type MageryContext = CraftContext & { backpack: () => number };

// Buys up to `amount` of each wanted graphic from the mage in one visit.
export async function shop(ctx: MageryContext, wanted: Map<number, number>, budget: number) {
  const { session } = ctx;
  return atVendor(ctx, 'mage', Actions.buy, async (vendor) => {
    const stock = await buyOffers(session, vendor, Actions.buy);
    if ('why' in stock) return false;
    let bought = false;
    for (const offer of stock.offers) {
      const graphic = session.world.entities.get(offer.serial)?.graphic ?? 0;
      const amount = Math.min(wanted.get(graphic) ?? 0, Math.floor(budget / Math.max(1, offer.price)));
      if (amount < 1) continue;
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
  if ((!count(spellbook) && !affords(30)) || (short && !affords(60))) return 0;
  if (!count(spellbook) && !(await shop(ctx, new Map([[spellbook, 1]]), 30))) return 0;
  // Looted scrolls go into the spellbook first; duplicates stay in the pack for sale.
  const carriedSpellbook = () => carried(ctx.backpack()).find((item) => item.graphic === spellbook);
  for (const scroll of carried(ctx.backpack()).filter((item) => isSpellScroll(item.graphic))) {
    const target = carriedSpellbook();
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
        5000,
        { resource: 'target' }
      )
      .catch(() => {});
    if (session.world.target) {
      session.target({ serial: ctx.serial, x: 0, y: 0, z: 0, graphic: 0 });
      casts++;
    } else if ('untargeted' in current && reply() === undefined) {
      casts++;
    } else if (reply() === NO_SPELL) {
      // Scrolls dropped on the spellbook are absorbed into it (Spellbook.OnDragDrop). Vendors sell
      // circles 1-3; higher circles wait for a looted scroll.
      const buyable = current.circle <= VENDOR_CIRCLES;
      if (!count(current.scroll) && (!buyable || !(await shop(ctx, new Map([[current.scroll, 1]]), 40)))) {
        missing.add(current.id);
        continue;
      }
      const scroll = carried(ctx.backpack()).find((item) => item.graphic === current.scroll);
      const found = carried(ctx.backpack()).find((item) => item.graphic === spellbook);
      if (!scroll || !found) break;
      await session.moveItem(scroll.serial, found.serial).catch(() => {});
      if (session.world.entities.has(scroll.serial)) break;
      log(`Added ${current.name} to the spellbook`);
    }
    await Bun.sleep(1200 + Math.random() * 400);
    await session.refreshStatus();
  }
  log(`Practised Magery ${casts} times`);
  return casts;
}

// The combat spells casters fight with, from the circles SBMage sells scrolls for.
const combatScrolls = new Map(
  ['Magic Arrow', 'Heal', 'Harm', 'Cure', 'Poison', 'Fireball', 'Bless'].map((name) => {
    const { id, scroll } = spellNamed(name);
    return [id, scroll];
  })
);

// Gives a caster a spellbook holding its vendor-sold combat spells. Each spell is tried at most once
// a day, and only until it is known to be in the spellbook (kept with the resident, so restarts do not
// repeat it): a cast answered with "You do not have that spell!" decides whether to buy its scroll.
export async function prepareSpellbook(ctx: MageryContext) {
  const { session } = ctx;
  ctx.checkpoint.spells ??= { checked: 0, has: [] };
  const spells = ctx.checkpoint.spells;
  if (spells.checked > Date.now() - 24 * 3_600_000) return;
  spells.checked = Date.now();
  // A spellbook in hand or in a bag counts: a caster never buys a second one.
  const ownsBook = () =>
    packItems(session, ctx.backpack()).some((item) => item.graphic === spellbook) ||
    session.world.childrenOf(session.world.serial ?? -1).some((item) => item.graphic === spellbook);
  // A new spellbook starts empty.
  if (!ownsBook()) spells.has = [];
  if (!ownsBook() && !(await shop(ctx, new Map([[spellbook, 1]]), 30))) return;
  for (const [id, scroll] of combatScrolls) {
    if (session.world.target) break;
    await ensureSpell(ctx, id, scroll);
  }
}

// Puts one spell in the spellbook: tried by casting once (and the cursor dropped), its scroll bought
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
  const target = carried(ctx.backpack()).find((i) => i.graphic === spellbook);
  if (item && target) await session.moveItem(item.serial, target.serial).catch(() => {});
  if (item && !session.world.entities.has(item.serial)) spells.has.push(id);
  return spells.has.includes(id);
}
