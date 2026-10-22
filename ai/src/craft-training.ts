import { readFileSync } from 'node:fs';

import { tally } from './activity';
import { canSpendOnTraining, chargedPurchase, offersBank, openBankBox, recordTrainingSpend } from './bank-gold';
import { type ServiceType, serviceLocations } from './locations';
import { buttonFor, CREATED, EXCEPTIONAL, FAILED, STOP } from './miner-crafting';
import { approachVendor } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { gumpCommands } from './protocol/gumps';
import type { Entity } from './protocol/world';
import { skillId } from './skills';

// One crafting skill: tools bought from and goods sold to `vendor`, recipes from the Def* craft
// system (group cliloc, item label, minimum skill, material count).
export interface CraftSkill {
  skill: string;
  vendor: ServiceType;
  tools: Set<number>;
  toolPrice: number;
  material: number;
  // Dyed material works the same (cloth). Coloured ingots and boards are other resources, so
  // crafts without this count only the plain material.
  anyHue?: boolean;
  // `max` (the skill at which success is certain) and `pays` (the vendor's price, SB* sell info)
  // let a crafter choose by profit; recipes without them are chosen by skill alone.
  recipes: {
    name?: string;
    group: number;
    label: number;
    min: number;
    amount: number;
    max?: number;
    pays?: number;
    // A recipe's own material (alchemy: its reagent) and anything else it takes (a bottle).
    material?: number;
    extra?: { graphic: number; amount: number }[];
  }[];
  // Gold a unit of material costs (bought, or what the raw material would sell for); `costs`
  // prices materials individually (reagents, bottles).
  unitCost?: number;
  costs?: Record<number, number>;
}

// Every single-material recipe of a craft skill, from catalogs/crafts (build-crafts.ts), by
// minimum skill: ServUO's own groups, labels, skill ranges, material counts and vendor prices.
export function craftRecipes(skill: string): CraftSkill['recipes'] {
  const file = new URL(`../catalogs/crafts/${skill.toLowerCase()}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { recipes: CraftSkill['recipes'] }).recipes;
}

// Which recipe to craft. Below its skill goal (or in training mode) the highest the skill allows;
// buying its material counts against the hourly training budget (bank-gold.ts), which caps what
// training at a loss costs. At the goal, the recipe with the best expected gold per attempt: chance
// x price - material used x cost, a failure wasting half the material (ServUO ConsumeType.Half), or
// undefined when none pays (vendor prices rarely cover bought material).
export function chooseRecipe(craft: CraftSkill, skill: number, mode: 'training' | 'profit', goal = 100) {
  const allowed = craft.recipes.filter((r) => skill >= r.min);
  // Training takes the hardest recipe still teaching something (skill below its max) that the
  // vendor buys back, so practice never fills the pack with goods nobody takes.
  const learning = allowed.filter((r) => skill < (r.max ?? 200));
  const training = learning.filter((r) => r.pays !== 0).at(-1) ?? learning.at(-1) ?? allowed.at(-1);
  if (
    mode === 'training' ||
    skill < goal ||
    !training ||
    allowed.some((r) => r.max === undefined || r.pays === undefined)
  )
    return training;
  const profit = (r: CraftSkill['recipes'][number]) => {
    const chance = Math.max(0, Math.min(1, (skill - r.min) / ((r.max ?? r.min + 25) - r.min)));
    const used = chance * r.amount + (1 - chance) * Math.max(1, Math.floor(r.amount / 2));
    const cost = (graphic: number) => craft.costs?.[graphic] ?? craft.unitCost ?? 0;
    const extras = (r.extra ?? []).reduce((sum, e) => sum + e.amount * cost(e.graphic), 0);
    return chance * (r.pays ?? 0) - used * cost(r.material ?? craft.material) - extras;
  };
  const best = allowed.reduce((a, b) => (profit(b) > profit(a) ? b : a));
  return profit(best) > 0 ? best : undefined;
}

export const tinkering: CraftSkill = {
  skill: 'Tinkering',
  vendor: 'tinker',
  tools: new Set([0x1eb8, 0x1ebc]),
  toolPrice: 15,
  material: 0x1bf2,
  recipes: craftRecipes('Tinkering'),
  unitCost: 5
};

export const carpentry: CraftSkill = {
  skill: 'Carpentry',
  vendor: 'carpenter',
  tools: new Set([0x1034, 0x1035, 0x1028, 0x1029]),
  toolPrice: 20,
  material: 0x1bd7,
  recipes: craftRecipes('Carpentry'),
  unitCost: 3
};

export type CraftContext = Pick<
  MountContext,
  'session' | 'serial' | 'terrain' | 'position' | 'navigate' | 'check' | 'phase' | 'log' | 'checkpoint' | 'status'
> & {
  city: string;
  carried: (backpack: number) => Entity[];
  // Brings at least `least` material into the pack (a bank withdrawal); false when none is left.
  refill?: (backpack: number, least: number, graphic: number) => Promise<boolean>;
};

// One vendor interaction (3006103 buy, 3006104 sell) at the first stop where it succeeds.
export async function atVendor(
  ctx: CraftContext,
  vendorType: ServiceType,
  cliloc: number,
  act: (vendor: number) => Promise<boolean>
) {
  const { session, navigate, position } = ctx;
  for (const shop of serviceLocations(ctx.city, vendorType)) {
    await navigate(shop, 4);
    for (const mobile of [...session.world.entities.values()]) {
      if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
      const entry = (await session.context(mobile.serial).catch(() => [])).find(
        (e) => e.cliloc === cliloc && !(e.flags & 1)
      );
      if (!entry) continue;
      // Vendors trade within eight tiles; a crowd at the counter does not block a purchase.
      await approachVendor(ctx, mobile.serial);
      if (await act(mobile.serial)) return true;
    }
  }
  return false;
}

// Practises a crafting skill until `until` with the recipe `chooseRecipe` picks, output sold to the
// skill's vendor. Returns the number of craft attempts.
export async function trainCraft(
  ctx: CraftContext,
  craft: CraftSkill,
  backpack: number,
  until: number,
  goal?: { mode: 'training' | 'profit'; skill?: number }
) {
  const { session, carried, check, phase, log } = ctx;
  const skill = () => session.world.skills.get(skillId(craft.skill))?.base ?? 0;
  const stock = (graphic = craft.material) =>
    carried(backpack)
      .filter((item) => item.graphic === graphic && (craft.anyHue || !item.hue))
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const tool = () => carried(backpack).find((item) => craft.tools.has(item.graphic));
  const recipe = () => chooseRecipe(craft, skill(), goal?.mode ?? 'training', goal?.skill);
  if (!recipe()) return 0;
  if (!tool()) {
    const bought = await atVendor(ctx, craft.vendor, 3006103, async (vendor) => {
      const before = session.world.received.get(0x74) ?? 0;
      session.world.buyOffers.clear();
      const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006103);
      if (!entry) return false;
      session.selectContext(vendor, entry.index);
      await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'tool stock', 2500).catch(() => {});
      const offer = [...session.world.buyOffers.values()]
        .flat()
        .find((o) => craft.tools.has(session.world.entities.get(o.serial)?.graphic ?? 0) && o.price <= craft.toolPrice);
      if (!offer || !canSpendOnTraining(session, backpack, ctx.checkpoint, offer.price)) return false;
      await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
        session.purchaseItem(vendor, offer.serial, backpack, 1, craft.toolPrice)
      );
      recordTrainingSpend(ctx.checkpoint, offer.price);
      return true;
    });
    if (!bought) return 0;
  }
  const made = new Set<number>();
  let attempts = 0;
  phase('training', `Practising ${craft.skill}`);
  const groups = new Set(craft.recipes.map((r) => String(r.group)));
  const craftGump = () =>
    [...session.world.gumps.values()].find((g) => [...groups].some((group) => g.layout.includes(group)));
  while (Date.now() < until && skill() < 100) {
    check();
    const current = recipe();
    const kit = tool();
    if (!current || !kit) break;
    // Every material the recipe takes, refilled when short (its own, then extras such as bottles).
    const needs = [{ graphic: current.material ?? craft.material, amount: current.amount }, ...(current.extra ?? [])];
    let short = false;
    for (const need of needs) {
      if (stock(need.graphic) < need.amount) await ctx.refill?.(backpack, need.amount, need.graphic);
      short ||= stock(need.graphic) < need.amount;
    }
    if (short) break;
    if (!craftGump()) {
      session.use(kit.serial);
      await session.waitFor(() => !!craftGump(), `${craft.skill} menu`, 4000);
    }
    let gump = craftGump();
    if (!gump) break;
    if (buttonFor(gump.layout, current.label) === undefined) {
      const group = buttonFor(gump.layout, current.group);
      if (group === undefined) break;
      const shown = session.world.received.get(gump.packed ? 0xdd : 0xb0) ?? 0;
      session.replyGump(gump.serial, gump.id, group, []);
      await session.waitFor(
        () => (session.world.received.get(gump?.packed ? 0xdd : 0xb0) ?? 0) > shown,
        'craft group',
        4000
      );
      gump = craftGump();
    }
    const button = gump && buttonFor(gump.layout, current.label);
    if (!gump || button === undefined) break;
    const before = new Set(carried(backpack).map((item) => item.serial));
    const seen = new Set(session.world.journal);
    const known = [...CREATED, ...FAILED, ...STOP];
    const menus = () => (session.world.received.get(0xdd) ?? 0) + (session.world.received.get(0xb0) ?? 0);
    const shown = menus();
    // ServUO shows the result as the re-sent menu's notice (CraftGump at 170,295) or as a message.
    const reply = () =>
      session.world.journal.find((e) => !seen.has(e) && known.includes(e.cliloc ?? 0))?.cliloc ??
      (menus() > shown
        ? gumpCommands(craftGump()?.layout ?? '')
            .filter((c) => c[0]?.startsWith('xmfhtml') && c[1] === '170' && c[2] === '295')
            .map((c) => Number(c[5]))
            .find((cliloc) => known.includes(cliloc))
        : undefined);
    session.replyGump(gump.serial, gump.id, button, []);
    await session.waitFor(() => reply() !== undefined, 'craft result', 8000);
    attempts++;
    if (STOP.includes(reply() ?? 0)) break;
    for (const item of carried(backpack))
      if (
        !before.has(item.serial) &&
        item.graphic !== craft.material &&
        !needs.some((need) => need.graphic === item.graphic) &&
        !craft.tools.has(item.graphic)
      ) {
        tally(session, 'crafted');
        // Exceptional pieces are banked, not sold.
        if (EXCEPTIONAL.includes(reply() ?? 0)) {
          ctx.checkpoint.keep = [...new Set([...(ctx.checkpoint.keep ?? []), item.serial])];
          log(`Exceptional ${craft.skill} piece; keeping it for the bank`);
        } else if (!ctx.checkpoint.keep?.includes(item.serial)) made.add(item.serial);
      }
    await Bun.sleep(600);
    if (made.size >= 8 || ctx.status().weight > ctx.status().maxWeight * 0.8) await sell(ctx, craft, made);
  }
  if (made.size) await sell(ctx, craft, made);
  await bankKept(ctx, backpack);
  log(`Practised ${craft.skill} ${attempts} times`);
  return attempts;
}

// Deposits kept exceptional pieces with the town's banker.
async function bankKept(ctx: CraftContext, backpack: number) {
  const { session } = ctx;
  const kept = ctx.carried(backpack).filter((item) => ctx.checkpoint.keep?.includes(item.serial));
  if (!kept.length) return;
  const bank = serviceLocations(ctx.city, 'banker')[0];
  if (!bank) return;
  ctx.phase('bank-keep', `Banking ${kept.length} exceptional piece${kept.length > 1 ? 's' : ''}`);
  await ctx.navigate(bank, 4);
  for (const mobile of session.world.entities.values()) {
    if (!mobile.position || distance(ctx.position(), mobile.position) > 12) continue;
    if (!(await offersBank(session, mobile.serial))) continue;
    const box = await openBankBox(ctx, mobile.serial);
    for (const item of kept) {
      ctx.check();
      await session.moveItem(item.serial, box);
      ctx.checkpoint.keep = ctx.checkpoint.keep?.filter((serial) => serial !== item.serial);
      await Bun.sleep(700);
    }
    return;
  }
}

async function sell(ctx: CraftContext, craft: CraftSkill, made: Set<number>) {
  const { session } = ctx;
  await atVendor(ctx, craft.vendor, 3006104, async (vendor) => {
    const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006104);
    if (!entry) return false;
    session.world.sellOffers.delete(vendor);
    session.selectContext(vendor, entry.index);
    await session.waitFor(() => session.world.sellOffers.has(vendor), 'craft buying list', 2500).catch(() => {});
    const sale = (session.world.sellOffers.get(vendor) ?? []).filter(
      (offer) => made.has(offer.serial) && offer.price > 0
    );
    if (!sale.length) return false;
    await session.sell(
      vendor,
      sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
    );
    for (const offer of sale) made.delete(offer.serial);
    return true;
  });
}
