import { tally } from './activity';
import { type CraftSkill, chooseRecipe, trainCraft } from './craft-training';
import { pickLocation } from './locations';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { gumpCommands } from './protocol/gumps';
import type { Entity } from './protocol/world';

// Bulk orders, a crafter's steady income (ServUO BulkOrderSystem, the new system from Time of
// Legends): a shopkeeper of the trade offers one through "Bulk Order Info" (6152) when its timer
// allows. The offer (SmallBODAcceptGump) names the item, the amount and any requirement; the
// crafter takes only plain orders it can make (no exceptional or coloured-material requirement).
// It makes the items, combines them into the deed (its gump's Combine button, then a cursor per
// item), and hands the finished deed to a shopkeeper of the trade: the gold goes straight to the
// bank (BaseVendor.OnDragDrop), and the points are banked for later (ConfirmBankPointsGump), which
// the server needs answered before the next turn-in.
const INFO = 3006152;
const DEED = 0x2258;
const OFFER_TITLE = 1045133; // A bulk order
const EXCEPTIONAL = 1045141;
// Material requirements on an offer: coloured ingots (1045142-1045150) and leathers (1049348-1049350).
const coloured = (cliloc: number) =>
  (cliloc >= 1045142 && cliloc <= 1045150) || (cliloc >= 1049348 && cliloc <= 1049350);
const NEXT_OFFER = 1072058; // An offer may be available in about ~1_minutes~ minutes.
const POINTS_TITLE = 1157076;

type Ctx = ProfessionContext & { refill?: (pack: number, least: number, graphic: number) => Promise<boolean> };

interface Order {
  deed: Entity;
  label: number;
  want: number;
  have: number;
}

const gumpWith = (ctx: Ctx, cliloc: number) =>
  [...ctx.session.world.gumps.values()].find((gump) =>
    gumpCommands(gump.layout).some((c) => c[0]?.startsWith('xmfhtml') && Number(c[5]) === cliloc)
  );

async function orders(ctx: Ctx): Promise<Order[]> {
  const deeds = ctx.carried().filter((item) => item.graphic === DEED);
  const found: Order[] = [];
  for (const deed of deeds) {
    await ctx.session.inspectProperties(deed.serial).catch(() => {});
    const properties = ctx.session.world.entities.get(deed.serial)?.properties ?? [];
    const want = Number(properties.find((p) => p.cliloc === 1060656)?.arguments ?? 0);
    const [item, have] = (properties.find((p) => p.cliloc === 1060658)?.arguments ?? '').split('\t');
    const label = Number((item ?? '').replace('#', ''));
    if (want && label) found.push({ deed, label, want, have: Number(have ?? 0) });
  }
  return found;
}

// At a shopkeeper of the trade, reached and in view: the mobile offering "Bulk Order Info".
async function shopkeeper(ctx: Ctx, craft: CraftSkill) {
  const shop = pickLocation(ctx.city, craft.vendor);
  if (!shop) return undefined;
  await ctx.navigate(shop, 4).catch(() => {});
  for (const mobile of [...ctx.session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || mobile.notoriety !== 7 || !mobile.position) continue;
    if (distance(ctx.position(), mobile.position) > 10) continue;
    const entry = (await ctx.session.context(mobile.serial).catch(() => [])).find((e) => e.cliloc === INFO);
    if (entry) return { mobile, entry };
  }
  return undefined;
}

async function turnIn(ctx: Ctx, craft: CraftSkill, order: Order) {
  const { session } = ctx;
  const vendor = await shopkeeper(ctx, craft);
  if (!vendor?.mobile.position) return false;
  await ctx.navigate(vendor.mobile.position, 2).catch(() => {});
  ctx.phase('bulk-order-turn-in', `Handing in a finished bulk order of ${order.want}`);
  // The deed is consumed on acceptance, so the ordinary move confirmation never comes.
  await session.moveItem(order.deed.serial, vendor.mobile.serial).catch(() => {});
  await session
    .waitFor(() => !session.world.entities.has(order.deed.serial), 'bulk order accepted', 4000)
    .catch(() => {});
  const points = await session
    .waitFor(() => !!gumpWith(ctx, POINTS_TITLE), 'bulk order points', 4000)
    .then(() => gumpWith(ctx, POINTS_TITLE))
    .catch(() => undefined);
  // Bank the points (the first choice), which clears the pending turn-in.
  if (points) session.replyGump(points.serial, points.id, 1, [1]);
  await Bun.sleep(1000);
  for (const gump of [...session.world.gumps.values()]) session.replyGump(gump.serial, gump.id, 0, []);
  if (session.world.entities.has(order.deed.serial)) return false;
  tally(session, 'bulkOrdersTurnedIn');
  ctx.log(`Turned in a bulk order of ${order.want}; the reward went to the bank`);
  return true;
}

async function combine(ctx: Ctx, order: Order, graphic: number) {
  const { session } = ctx;
  const pieces = ctx.carried().filter((item) => item.graphic === graphic);
  if (!pieces.length) return;
  ctx.phase('bulk-order-combine', `Combining ${pieces.length} pieces into the bulk order`);
  session.use(order.deed.serial);
  const gump = await session
    .waitFor(() => !!gumpWith(ctx, 1045138) || [...session.world.gumps.values()].length > 0, 'bulk order gump', 3000)
    .then(() => [...session.world.gumps.values()].at(-1))
    .catch(() => undefined);
  if (!gump) return;
  session.replyGump(gump.serial, gump.id, 2, []);
  for (const piece of pieces) {
    ctx.check();
    await session.waitFor(() => session.world.target !== null, 'combine cursor', 3000).catch(() => {});
    if (!session.world.target) break;
    session.target({ serial: piece.serial, x: 0, y: 0, z: 0, graphic: piece.graphic });
    await session.waitFor(() => !session.world.entities.has(piece.serial), 'piece combined', 3000).catch(() => {});
  }
  if (session.world.target) session.target(null);
}

// Asks for a new order when the timer allows and takes it when it is one this crafter can fill.
async function takeOrder(ctx: Ctx, craft: CraftSkill, skill: number) {
  const { session, checkpoint } = ctx;
  checkpoint.bulkOrders ??= { nextAt: 0 };
  if (checkpoint.bulkOrders.nextAt > Date.now()) return false;
  const vendor = await shopkeeper(ctx, craft);
  if (!vendor) {
    checkpoint.bulkOrders.nextAt = Date.now() + 60 * 60_000;
    return false;
  }
  const heard = new Set(session.world.journal);
  session.selectContext(vendor.mobile.serial, vendor.entry.index);
  await session
    .waitFor(
      () => !!gumpWith(ctx, OFFER_TITLE) || session.world.journal.some((e) => !heard.has(e) && e.cliloc === NEXT_OFFER),
      'bulk order offer',
      4000
    )
    .catch(() => {});
  const offer = gumpWith(ctx, OFFER_TITLE);
  if (!offer) {
    const minutes = Number(
      session.world.journal.find((e) => !heard.has(e) && e.cliloc === NEXT_OFFER)?.arguments ?? 60
    );
    checkpoint.bulkOrders.nextAt = Date.now() + (Number.isFinite(minutes) ? minutes : 60) * 60_000;
    return false;
  }
  const clilocs = gumpCommands(offer.layout)
    .filter((c) => c[0]?.startsWith('xmfhtml'))
    .map((c) => Number(c[5]));
  const item = gumpCommands(offer.layout).find((c) => c[0]?.startsWith('xmfhtml') && c[1] === '40' && c[2] === '120');
  const recipe = craft.recipes.find((r) => r.label === Number(item?.[5]));
  const plain = !clilocs.includes(EXCEPTIONAL) && !clilocs.some(coloured);
  const doable = !!recipe && plain && skill >= recipe.min + 10;
  session.replyGump(offer.serial, offer.id, doable ? 1 : 0, []);
  // Offers come about every six hours; the next ask waits at least that long either way.
  checkpoint.bulkOrders.nextAt = Date.now() + 6 * 3_600_000;
  ctx.log(
    doable
      ? `Took a bulk order for ${recipe?.name ?? 'an item'}`
      : `Declined a bulk order (${!recipe ? 'not a recipe I know' : !plain ? 'special requirements' : 'beyond my skill'})`
  );
  ctx.persist();
  return doable;
}

// One step of bulk-order work, true when it did something: hand in a finished order, fill an
// open one, or take a new one. Crafting for an order keeps its pieces from the shop.
export async function bulkOrderTurn(ctx: Ctx, craft: CraftSkill, skill: number): Promise<boolean> {
  let open = await orders(ctx);
  for (const order of open.filter((o) => o.have >= o.want)) await turnIn(ctx, craft, order);
  open = open.filter((o) => o.have < o.want);
  if (!open.length && !(await takeOrder(ctx, craft, skill))) return false;
  open = open.length ? open : await orders(ctx);
  const order = open.find((o) => o.have < o.want);
  if (!order) return true;
  const recipe = craft.recipes.find((r) => r.label === order.label);
  if (!recipe?.name || !chooseRecipe(craft, skill, 'profit', 0, [recipe.name])) return false;
  const graphic = order.label - 1020000;
  const missing = order.want - order.have - ctx.carried().filter((item) => item.graphic === graphic).length;
  // An order it cannot make progress on (no material and no money for it) waits an hour while the
  // crafter earns, instead of retrying every turn.
  if ((ctx.checkpoint.bulkOrders?.stalledUntil ?? 0) > Date.now()) return false;
  if (missing > 0) {
    ctx.phase('bulk-order-craft', `Making ${missing} ${recipe.name} for a bulk order`);
    await trainCraft(
      { ...ctx, hold: new Set([graphic]) },
      craft,
      ctx.backpack(),
      Math.min(ctx.deadline, Date.now() + 5 * 60_000),
      { mode: 'profit', skill: 0, prefer: [recipe.name] }
    );
  }
  const made = ctx.carried().filter((item) => item.graphic === graphic).length;
  if (missing > 0 && order.want - order.have - made >= missing) {
    ctx.checkpoint.bulkOrders = { nextAt: 0, ...ctx.checkpoint.bulkOrders, stalledUntil: Date.now() + 60 * 60_000 };
    ctx.persist();
    ctx.log(`Could not make any ${recipe.name} for the bulk order; back to it in an hour`);
    return false;
  }
  await combine(ctx, order, graphic);
  const [updated] = (await orders(ctx)).filter((o) => o.deed.serial === order.deed.serial);
  if (updated && updated.have >= updated.want) await turnIn(ctx, craft, updated);
  return true;
}
