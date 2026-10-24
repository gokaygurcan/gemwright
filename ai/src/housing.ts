import { tally } from './activity';
import { chargedPurchase, fundsStale, refreshFunds } from './bank-gold';
import { atVendor, type CraftContext } from './craft-training';
import { awaitGump, awaitMessage, dismiss, heardSince, mark, press } from './gump-flow';
import { claimLot, dropClaim, type HouseRecord, houseOf, housingOpen, refuseLot, updateHouse } from './house-lots';
import type { LifeContext } from './life';
import { serviceLocations } from './locations';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import { world } from './world';

// Buying a house, as a player does: a House Placement Tool from an architect (627 gold), the
// tool's menu (Classic Houses, then the house), the house's outline targeted on the resident's
// lot in a housing district (house-lots.ts), and the placement warning accepted; ServUO takes the
// price from the bank (HousePlacementTool.cs, PlacementWarning_Callback). One house per account.
// The six 7x7 classic houses, in the order of ServUO's EJ placement list (HousesEJ, button 1-6).
export const HOUSES = [
  { name: 'Stone and Plaster House', cliloc: 1011303, cost: 36750 },
  { name: 'Field Stone House', cliloc: 1011304, cost: 36750 },
  { name: 'Small Brick House', cliloc: 1011305, cost: 36500 },
  { name: 'Wooden House', cliloc: 1011306, cost: 35000 },
  { name: 'Wood and Plaster House', cliloc: 1011307, cost: 36500 },
  { name: 'Thatched-Roof Cottage', cliloc: 1011308, cost: 36500 }
] as const;
const TOOL = 0x14f6;
const TOOL_PRICE = 627;
const KEY = 0x100f;
const reserve = () => world.housing?.reserve ?? 3000;
// What a resident needs in the bank before it goes to buy: the dearest house, the tool, the reserve.
export const houseGoal = () => Math.max(...HOUSES.map((h) => h.cost)) + TOOL_PRICE + reserve();
// From 5,000 banked a resident without a house is saving for one: no luxuries (fighter-town.ts,
// pack-animal.ts), so the goal comes nearer.
const SAVING_FROM = 5000;

export const ownerOf = (ctx: Pick<LifeContext, 'session'>) => {
  const serial = ctx.session.world.serial;
  return (serial === null ? undefined : ctx.session.world.entities.get(serial)?.name) ?? '';
};
export const ownsHouse = (owner: string) => {
  const status = houseOf(owner)?.status;
  return status === 'placed' || status === 'elsewhere';
};
export function saving(ctx: Pick<LifeContext, 'session' | 'checkpoint'>) {
  const owner = ownerOf(ctx);
  return housingOpen() && !!owner && !ownsHouse(owner) && (ctx.checkpoint.funds?.bank ?? 0) >= SAVING_FROM;
}

export const backpackOf = (ctx: Pick<LifeContext, 'session'>) => {
  const serial = ctx.session.world.serial;
  const pack =
    serial === null ? undefined : ctx.session.world.childrenOf(serial).find((i) => i.layer === Layer.Backpack);
  if (!pack) throw new Error('Backpack is not observed');
  return pack.serial;
};
export const craftContext = (ctx: LifeContext): CraftContext & { backpack: () => number } => ({
  session: ctx.session,
  serial: ctx.session.world.serial ?? 0,
  terrain: ctx.terrain,
  position: ctx.position,
  navigate: ctx.navigate,
  check: ctx.check,
  phase: ctx.phase,
  log: ctx.log,
  checkpoint: ctx.checkpoint,
  status: () => {
    const status = ctx.session.world.status;
    if (!status) throw new Error('Character status is unknown');
    return status;
  },
  city: ctx.city,
  carried: (backpack) => ctx.session.world.childrenOf(backpack),
  backpack: () => backpackOf(ctx)
});

// Walks there, or by the moongate nearest it when far.
export async function travelTo(ctx: LifeContext, point: { x: number; y: number }, within = 2) {
  if (distance(ctx.position(), point) > 300) {
    const gate = nearestGate(point);
    if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
  }
  await ctx.navigate(point, within);
}

// One vendor item bought by graphic from a shop of `service`, at most `price` gold.
export async function buyOne(ctx: LifeContext, service: 'architect' | 'provisioner', graphic: number, price: number) {
  const trade = craftContext(ctx);
  const { session } = ctx;
  return atVendor(trade, service, 3006103, async (vendor) => {
    const before = session.world.received.get(0x74) ?? 0;
    session.world.buyOffers.clear();
    const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006103);
    if (!entry) return false;
    session.selectContext(vendor, entry.index);
    await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'vendor stock', 2500).catch(() => {});
    const offer = [...session.world.buyOffers.values()]
      .flat()
      .find((o) => session.world.entities.get(o.serial)?.graphic === graphic && o.price <= price);
    if (!offer) return false;
    await chargedPurchase(trade, offer.price, () =>
      session.purchaseItem(vendor, offer.serial, trade.backpack(), 1, offer.price)
    );
    return true;
  });
}

// The house this resident can afford, chosen by name so each keeps to its liking.
function houseFor(owner: string, funds: number) {
  const affordable = HOUSES.map((house, index) => ({ ...house, button: index + 1 })).filter(
    (h) => h.cost + TOOL_PRICE + reserve() <= funds
  );
  const seed = [...owner].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return affordable[seed % Math.max(1, affordable.length)];
}

// Placement outcomes (HousePlacementTool.cs): valid, blocked or bad terrain, no housing here or
// now, no funds in the bank, the preview expired, and one house per account.
const VALID = 1011576;
const BLOCKED = [1043287, 501265, 501270, 1150493];
const NO_FUNDS = 1060646;
const EXPIRED = 1060637;
const ALREADY_OWNS = 501271;

export type Purchase = 'placed' | 'refused' | 'unaffordable' | 'failed' | 'no-lot';

// One attempt at buying the house on the resident's lot.
export async function buyHouse(ctx: LifeContext): Promise<Purchase> {
  const { session } = ctx;
  const owner = ownerOf(ctx);
  const bank = serviceLocations(ctx.city, 'banker')[0] ?? ctx.position();
  if (fundsStale(ctx.checkpoint)) await refreshFunds(craftContext(ctx), ctx.city);
  const house = houseFor(owner, fundsStale(ctx.checkpoint) ? 0 : (ctx.checkpoint.funds?.bank ?? 0));
  if (!house) return 'unaffordable';
  const lot = claimLot(owner, bank);
  if (!lot) return 'no-lot';
  ctx.phase('housing', `Buying a ${house.name} on lot ${lot.lot}`);
  const tool = () => session.world.childrenOf(backpackOf(ctx)).find((i) => i.graphic === TOOL);
  if (!tool() && !(await buyOne(ctx, 'architect', TOOL, TOOL_PRICE + 100).catch(() => false))) {
    ctx.log('Could not buy a house placement tool');
    return 'failed';
  }
  const placer = tool();
  if (!placer) return 'failed';
  // The outline is targeted on the front steps (the classic list's offset is four tiles south).
  const front = { x: lot.x, y: lot.y + 4, z: lot.z };
  await travelTo(ctx, { x: lot.x, y: lot.y + 7 }, 2);
  dismiss(session, 1060239);
  session.use(placer.serial);
  press(session, await awaitGump(session, 1060390, 'house placement menu'), 1);
  press(session, await awaitGump(session, 1060235, 'classic house list'), house.button);
  await session.waitFor(() => session.world.target?.multi !== undefined, 'house outline', 8000);
  const from = mark(session);
  session.target({ serial: 0, ...front, graphic: 0 });
  const checked = await awaitMessage(session, from, [VALID, ...BLOCKED], 'placement check');
  if (checked !== VALID) {
    dismiss(session, 1060239);
    if (checked !== undefined) {
      refuseLot(owner, lot.lot, `cliloc ${checked}`);
      ctx.log(`Lot ${lot.lot} refused (${checked}); another one next time`);
      return 'refused';
    }
    return 'failed';
  }
  const keys = new Set(
    session.world
      .childrenOf(backpackOf(ctx))
      .filter((i) => i.graphic === KEY)
      .map((i) => i.serial)
  );
  const confirm = mark(session);
  press(session, await awaitGump(session, 1060635, 'placement warning'), 1);
  const newKey = () => session.world.childrenOf(backpackOf(ctx)).find((i) => i.graphic === KEY && !keys.has(i.serial));
  const failures = [NO_FUNDS, EXPIRED, ALREADY_OWNS];
  await session
    .waitFor(() => !!newKey() || heardSince(session, confirm, failures) !== undefined, 'house placement', 10_000)
    .catch(() => {});
  dismiss(session, 1060239);
  const outcome = heardSince(session, confirm, failures);
  if (outcome === ALREADY_OWNS) {
    // A house from before (another life of this account): it stands somewhere; no second one.
    updateHouse(owner, { status: 'elsewhere' });
    return 'placed';
  }
  if (outcome === NO_FUNDS) {
    delete ctx.checkpoint.funds;
    dropClaim(owner);
    return 'unaffordable';
  }
  if (!newKey()) return 'failed';
  if (ctx.checkpoint.funds) ctx.checkpoint.funds.bank = Math.max(0, ctx.checkpoint.funds.bank - house.cost);
  updateHouse(owner, { status: 'placed', house: house.name, placedAt: Date.now(), visitedAt: Date.now() });
  tally(session, 'housesBought');
  ctx.log(`Bought a ${house.name} at ${lot.x},${lot.y}`);
  ctx.persist();
  return 'placed';
}

export const houseRecord = (ctx: Pick<LifeContext, 'session'>): HouseRecord | undefined => houseOf(ownerOf(ctx));
