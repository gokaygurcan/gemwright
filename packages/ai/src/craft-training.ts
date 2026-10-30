import { readFileSync } from 'node:fs';

import { board, ingot } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { gumpCommands } from '@gemwright/network/gumps';
import { Notoriety, Opcode } from '@gemwright/network/opcodes';
import { Actions, ShardCraft } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { tally } from './activity';
import { withinReach } from './areas';
import { canSpendOnTraining, chargedPurchase, recordTrainingSpend, refreshFunds, TOOLS } from './bank-gold';
import { Blocked } from './blocked';
import { bankKept } from './craft-banking';
import { sellCrafted as sell } from './craft-sales';
import { confinedToHaven } from './haven';
import { learnQuality, quality } from './item-quality';
import { allServiceLocations, type ServiceType, serviceLocations, townAt, vendorLocations } from './locations';
import { buttonFor, CREATED, EXCEPTIONAL, FAILED, STOP } from './miner-crafting';
import { approachVendor } from './mobile-approach';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { failResidentGoal } from './resident-goal';
import { atSmithingStation, rejectSmithingStation } from './smithing-stations';
import { reachableFrom } from './unreachable';

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
export function chooseRecipe(
  craft: CraftSkill,
  skill: number,
  mode: 'training' | 'profit',
  goal = 100,
  prefer: readonly string[] = []
) {
  const allowed = craft.recipes.filter((r) => skill >= r.min);
  // Goods residents buy (market.ts) come first, in the caller's order, by exact recipe name.
  const wanted = prefer.map((name) => allowed.find((r) => r.name === name)).find((r) => r !== undefined);
  if (wanted) return wanted;
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
  material: ingot,
  recipes: craftRecipes('Tinkering'),
  unitCost: 5
};

export const carpentry: CraftSkill = {
  skill: 'Carpentry',
  vendor: 'carpenter',
  tools: new Set([0x1034, 0x1035, 0x1028, 0x1029]),
  toolPrice: 20,
  material: board,
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
  // Goods kept back from the shop for the resident market (market.ts), up to 20 of each graphic.
  hold?: ReadonlySet<number>;
  // Exceptional pieces stay in the pack for the resident market instead of the bank (bowyers).
  holdExceptional?: boolean;
  // Spending limits for tools and materials (bank-gold.ts); crafting for profit uses BUSINESS.
  limits?: { reserve: number; perHour: number };
  persist?: () => void;
  done?: () => boolean;
  onBlocked?: (reason: 'materials' | 'tool' | 'station' | 'menu') => void;
};

// One vendor interaction (Actions.buy buy, Actions.sell sell) at the first stop where it succeeds.
export async function atVendor(
  ctx: CraftContext,
  vendorType: ServiceType,
  cliloc: number,
  act: (vendor: number) => Promise<boolean>,
  objective = 'service'
) {
  const { session, navigate, position } = ctx;
  const town = townAt(position(), ctx.city);
  // A town without this kind of shop (Yew has no tinker) sends the crafter to the nearest ones.
  const own = serviceLocations(town, vendorType);
  const alternatives = allServiceLocations(vendorType)
    .filter((shop) => !own.some((point) => point.x === shop.x && point.y === shop.y))
    .sort((a, b) => distance(position(), a) - distance(position(), b));
  // Shops in walking reach only; a moongate trip to a far town's shop only for one who can pay
  // for what it goes for, and only the nearest such town. Nobody crosses the land on a hunch.
  const funds = (ctx.status().gold ?? 0) + (ctx.checkpoint.funds?.bank ?? 0);
  const walkable = alternatives.filter((shop) => distance(position(), shop) <= 300);
  const stops = [...own.filter((shop) => distance(position(), shop) <= 300 || funds >= 100), ...walkable.slice(0, 2)];
  // When none of this town's shops serves the need, the nearest other towns' shops are still worth
  // one trip: a fisher whose town's fishmonger cannot trade has nothing left to stay for. Selling
  // always travels (it is how the resident earns); buying only when it can pay for more than the
  // trip itself.
  const elsewhere =
    // A Young resident of Haven cannot take a gate (haven.ts): other towns' shops are not trips it
    // can make, so they are not tried at all (the block used to repeat every turn).
    !confinedToHaven(session) && (cliloc === Actions.sell || funds >= 100)
      ? alternatives.filter((shop) => !stops.some((stop) => stop.x === shop.x && stop.y === shop.y)).slice(0, 3)
      : [];
  // The shop landmark is the door; the vendor stands somewhere inside or beside it. The spawner data
  // (locations/vendors.json) lists where each kind of vendor actually appears in this town. A town
  // whose shops all failed this objective lately teaches nothing new: its spawn points wait too.
  const objectiveKey = (x: number, y: number) =>
    `shop:${session.world.map}:${vendorType}:${cliloc}:${x},${y}:${objective}`;
  const townBlocked =
    own.length > 0 &&
    own.every((shop) =>
      objectiveBlocked(ctx.checkpoint, objectiveKey(shop.x, shop.y), suppliesCondition(session, ctx.checkpoint))
    );
  const spawns = townBlocked
    ? []
    : vendorLocations(town, vendorType)
        .filter((point) => !stops.some((stop) => distance(stop, point) <= 3))
        .sort((a, b) => distance(position(), a) - distance(position(), b));
  // A vendor that answered before is the surest place to look again (kept for a day).
  const vendorKey = `${session.world.map ?? -1}:${town.toLowerCase()}:${vendorType}`;
  const remembered = ctx.checkpoint.landmarks?.vendors?.[vendorKey];
  const learn = (at: { x: number; y: number; z: number }) => {
    ctx.checkpoint.landmarks ??= { forges: [] };
    ctx.checkpoint.landmarks.vendors ??= {};
    ctx.checkpoint.landmarks.vendors[vendorKey] = { x: at.x, y: at.y, z: at.z, at: Date.now() };
    ctx.persist?.();
  };
  const planned = [
    ...(remembered && !townBlocked && Date.now() - remembered.at < 86_400_000
      ? [{ point: remembered, inTown: true }]
      : []),
    ...stops.map((point) => ({ point, inTown: own.some((shop) => shop.x === point.x && shop.y === point.y) })),
    ...spawns.map((point) => ({ point, inTown: true }))
  ];
  // What is standing within sight that sells or buys this: a vendor the catalogue never knew about —
  // a shop somebody added to the docks — is found by its menu, not by its address, and then
  // remembered (learn) for the next visit. Tried in town, before any trip to another town.
  const observed = [...session.world.entities.values()]
    .filter(
      (mobile) =>
        mobile.kind === 'mobile' &&
        mobile.notoriety === Notoriety.invulnerable &&
        mobile.position &&
        distance(position(), mobile.position) <= 60 &&
        !planned.some((visit) => distance(visit.point, mobile.position as { x: number; y: number }) <= 3)
    )
    .sort(
      (a, b) =>
        distance(position(), a.position as { x: number; y: number }) -
        distance(position(), b.position as { x: number; y: number })
    )
    .slice(0, 4)
    .map((mobile) => ({ point: mobile.position as { x: number; y: number; z: number }, inTown: true }));
  const visits = [...planned, ...observed, ...elsewhere.map((point) => ({ point, inTown: false }))];
  // Once this town's vendor answers with nothing for this objective, its other spawn points teach
  // nothing more on this visit; other towns are still tried.
  let townSettled = false;
  for (const { point: shop, inTown } of visits) {
    if (inTown && townSettled) continue;
    ctx.check();
    const key = objectiveKey(shop.x, shop.y);
    const condition = suppliesCondition(session, ctx.checkpoint);
    if (
      objectiveBlocked(ctx.checkpoint, key, condition) &&
      !ctx.checkpoint.objectives?.[key]?.reason?.startsWith('Too heavy')
    ) {
      ctx.log(`Trying another ${vendorType}: ${ctx.checkpoint.objectives?.[key]?.reason}`);
      continue;
    }
    if ((distance(position(), shop) < 300 && !reachableFrom(shop, position())) || !withinReach(position(), shop))
      continue;
    try {
      const gate = nearestGate(shop);
      if (distance(position(), shop) > 300 && distance(position(), moongates[gate]) > 2)
        await travelByMoongate(ctx, gate);
      await navigate(shop, 4);
      let heard = false;
      for (const mobile of [...session.world.entities.values()]) {
        if (mobile.kind !== 'mobile' || mobile.notoriety !== Notoriety.invulnerable || !mobile.position) continue;
        if (distance(position(), mobile.position) > 18) continue;
        const menu = async () =>
          (await session.context(mobile.serial)).find((entry) => entry.cliloc === cliloc && !(entry.flags & 1));
        // The shard answers a menu only within its update range and vendors wander: a request that
        // goes unanswered is retried from close range before another vendor is tried.
        let entry = await menu().catch(() => undefined);
        if (entry === undefined) {
          await approachVendor(ctx, mobile.serial).catch(() => {});
          entry = await menu().catch(() => undefined);
        }
        if (entry === undefined) continue;
        heard = true;
        await approachVendor(ctx, mobile.serial);
        if (await act(mobile.serial)) {
          completeObjective(ctx.checkpoint, key);
          learn(mobile.position);
          return true;
        }
      }
      if (!heard) {
        // No menu came back at all: nothing was learned about stock, so no shop ban is recorded.
        ctx.log(`No ${vendorType} answered near ${shop.x},${shop.y}`);
        continue;
      }
      townSettled ||= inTown;
      failObjective(
        ctx.checkpoint,
        key,
        suppliesCondition(session, ctx.checkpoint),
        'No usable stock, affordable offer or matching service'
      );
    } catch (error) {
      ctx.check();
      // Too heavy to walk is about the pack, not the shop: the resident lightens it first.
      if (!(error instanceof Blocked) || error.reason === 'overweight') throw error;
      failObjective(ctx.checkpoint, key, condition, error.message);
      ctx.log(`Trying another ${vendorType}: ${error.message}`);
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
  goal?: { mode: 'training' | 'profit'; skill?: number; prefer?: readonly string[] }
) {
  const { session, carried, check, phase, log } = ctx;
  const skill = () => session.world.skills.get(skillId(craft.skill))?.base ?? 0;
  const stock = (graphic = craft.material) =>
    carried(backpack)
      .filter((item) => item.graphic === graphic && (craft.anyHue || !item.hue))
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const tool = () => carried(backpack).find((item) => craft.tools.has(item.graphic));
  const recipe = () => chooseRecipe(craft, skill(), goal?.mode ?? 'training', goal?.skill, goal?.prefer);
  if (!recipe()) {
    failResidentGoal(session, `No viable ${craft.skill} recipe for this objective`);
    return 0;
  }
  // Tools and materials are charged to the bank: a stale balance would count carried coins only.
  await refreshFunds(ctx, ctx.city);
  if (!tool()) {
    let why: string | undefined;
    const bought = await atVendor(
      ctx,
      craft.vendor,
      Actions.buy,
      async (vendor) => {
        const before = session.world.received.get(Opcode.vendorBuyList) ?? 0;
        session.world.buyOffers.clear();
        const entry = (await session.context(vendor)).find((e) => e.cliloc === Actions.buy);
        if (!entry) return false;
        session.selectContext(vendor, entry.index);
        await session
          .waitFor(() => (session.world.received.get(Opcode.vendorBuyList) ?? 0) > before, 'tool stock', 2500)
          .catch(() => {});
        const offer = [...session.world.buyOffers.values()]
          .flat()
          .find(
            (o) => craft.tools.has(session.world.entities.get(o.serial)?.graphic ?? 0) && o.price <= craft.toolPrice
          );
        if (!offer) why = 'no tool in stock within the price';
        else if (!canSpendOnTraining(session, backpack, ctx.checkpoint, offer.price, TOOLS))
          why = 'funds held in reserve';
        if (!offer || why) return false;
        await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
          session.purchaseItem(vendor, offer.serial, backpack, 1, craft.toolPrice)
        );
        recordTrainingSpend(ctx.checkpoint, offer.price);
        return true;
      },
      `tool:${[...craft.tools].join(',')}`
    );
    if (!bought) {
      ctx.onBlocked?.('tool');
      if (!ctx.onBlocked) failResidentGoal(session, 'Required crafting tool unavailable');
      log(`No ${craft.skill} tool bought: ${why ?? 'no vendor answered'}`);
      return 0;
    }
  }
  const made = new Set<number>();
  // Goods left from earlier sessions (or a restart) are sold too, not carried forever: normal
  // pieces of what this craft makes (a recipe's label is 1020000 + its graphic).
  const products = new Set(craft.recipes.map((r) => r.label - 1020000));
  const toolsCarried = () => carried(backpack).filter((item) => craft.tools.has(item.graphic)).length;
  const spareTools = carried(backpack)
    .filter((item) => craft.tools.has(item.graphic))
    .slice(2)
    .map((item) => item.serial);
  const leftovers = carried(backpack).filter(
    (item) =>
      products.has(item.graphic) &&
      !ctx.hold?.has(item.graphic) &&
      !ctx.checkpoint.keep?.includes(item.serial) &&
      (!craft.tools.has(item.graphic) || spareTools.includes(item.serial))
  );
  await learnQuality(session, leftovers);
  for (const item of leftovers)
    if (quality(session.world.entities.get(item.serial) ?? item) === 'normal') made.add(item.serial);
  let attempts = 0;
  phase('training', `Practising ${craft.skill}`);
  const groups = new Set(craft.recipes.map((r) => String(r.group)));
  const craftGump = () =>
    [...session.world.gumps.values()].find((g) => [...groups].some((group) => g.layout.includes(group)));
  while (Date.now() < until && !ctx.done?.() && (goal?.mode === 'profit' || skill() < 100)) {
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
    if (short) {
      ctx.onBlocked?.('materials');
      if (!ctx.onBlocked) failResidentGoal(session, 'Required crafting materials unavailable');
      log(`No ${craft.skill} material for ${current.name} (none bought within the training budget)`);
      break;
    }
    if (craft.skill === 'Blacksmith' && !(await atSmithingStation(ctx))) {
      ctx.onBlocked?.('station');
      if (!ctx.onBlocked) failResidentGoal(session, 'No reachable crafting station');
      log('No reachable anvil and forge for Blacksmith crafting');
      break;
    }
    if (!craftGump()) {
      session.use(kit.serial);
      await session.waitFor(() => !!craftGump(), `${craft.skill} menu`, 4000);
    }
    let gump = craftGump();
    if (!gump) {
      ctx.onBlocked?.('menu');
      break;
    }
    if (buttonFor(gump.layout, current.label) === undefined) {
      const group = buttonFor(gump.layout, current.group);
      if (group === undefined) {
        ctx.onBlocked?.('menu');
        break;
      }
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
    if (!gump || button === undefined) {
      ctx.onBlocked?.('menu');
      break;
    }
    const before = new Set(carried(backpack).map((item) => item.serial));
    const seen = new Set(session.world.journal);
    const known = [...CREATED, ...FAILED, ...STOP];
    const menus = () =>
      (session.world.received.get(Opcode.compressedGump) ?? 0) + (session.world.received.get(Opcode.gump) ?? 0);
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
    if (STOP.includes(reply() ?? 0)) {
      const code = reply();
      const reason =
        code === ShardCraft.stationMessage ? 'station' : code === ShardCraft.toolWornOut ? 'tool' : 'materials';
      if (code === ShardCraft.stationMessage) rejectSmithingStation(ctx);
      ctx.onBlocked?.(reason);
      if (!ctx.onBlocked) failResidentGoal(session, `${craft.skill}: ${reason} (server reply ${code})`);
      log(`${craft.skill} stopped: ${reason} (server reply ${code})`);
      break;
    }
    for (const item of carried(backpack))
      if (
        !before.has(item.serial) &&
        item.graphic !== craft.material &&
        !needs.some((need) => need.graphic === item.graphic) &&
        // Its own tools are kept, two at most: any more made in practice are sold like other goods.
        !(craft.tools.has(item.graphic) && toolsCarried() <= 2)
      ) {
        tally(session, 'crafted');
        // Exceptional pieces are never sold to a shop: banked, or kept for residents.
        if (EXCEPTIONAL.includes(reply() ?? 0) && !ctx.hold?.has(item.graphic)) {
          // A few are held for residents; more than five of a kind go to the bank.
          const held = carried(backpack).filter(
            (i) => i.graphic === item.graphic && !ctx.checkpoint.keep?.includes(i.serial)
          );
          if (ctx.holdExceptional && held.length <= 5)
            log(`Exceptional ${craft.skill} piece; keeping it to trade with residents`);
          else {
            ctx.checkpoint.keep = [...new Set([...(ctx.checkpoint.keep ?? []), item.serial])];
            log(`Exceptional ${craft.skill} piece; keeping it for the bank`);
          }
        } else if (!ctx.checkpoint.keep?.includes(item.serial) && !(ctx.done && ctx.hold?.has(item.graphic)))
          made.add(item.serial);
      }
    await Bun.sleep(600);
    if (made.size >= 8 || ctx.status().weight > ctx.status().maxWeight * 0.9) await sell(ctx, craft, made, backpack);
  }
  if (made.size) await sell(ctx, craft, made, backpack);
  await bankKept(ctx, backpack);
  log(`Practised ${craft.skill} ${attempts} times`);
  return attempts;
}
