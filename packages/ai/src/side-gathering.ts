import { gold, miningTools, ore } from '@gemwright/common/items';

import { unsafeCheck } from './danger';
import { lasting } from './lasting';
import { pickLocation } from './locations';
import { chopTree } from './lumber-chop';
import { sellBoards } from './lumber-sell';
import { buyHatchetFrom, hatchets } from './lumber-shop';
import { treeStatics } from './lumber-trees';
import { digSite } from './miner-dig';
import { minerPlan } from './miner-plan';
import { findMiningSite } from './miner-sites';
import { createSmelter } from './miner-smelting';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { Layer } from './protocol/layers';
import { buyTool, sellTo } from './vendor-trade';
import { workAreas } from './work-areas';

// Two more side trades beside fishing (side-trade.ts), for a resident whose own work does not
// pay: chopping trees near town and selling the boards to the carpenter, or digging ore in a
// nearby mining district, smelting it at a forge and selling the iron to the smith. Each takes
// only a cheap tool (a hatchet, a pickaxe) and no skill to start, as for players.
const LOG = 0x1bdd;
const BOARD = 0x1bd7;
const INGOT = 0x1bf2;
const tool = (ctx: ProfessionContext, kinds: ReadonlySet<number>) =>
  [...ctx.carried(), ...ctx.session.world.childrenOf(ctx.serial)].find((item) => kinds.has(item.graphic));

export const woodNear = (ctx: ProfessionContext) =>
  !!pickLocation(ctx.city, 'carpenter') && ctx.terrain.findStatics(treeStatics, ctx.position(), 40).length > 0;
export const oreNear = (ctx: ProfessionContext) =>
  workAreas('mining').some((area) => distance(area, ctx.position()) <= 150);

// One load of wood: true when the turn went to it.
export async function woodTurn(ctx: ProfessionContext): Promise<boolean> {
  const { session } = ctx;
  if (!tool(ctx, hatchets) && ctx.count(gold) >= 30) await buyHatchetFrom({ ...ctx, city: ctx.city }).catch(() => {});
  if (!tool(ctx, hatchets)) return false;
  const depleted = lasting('tree', ctx.serial);
  const risky = unsafeCheck(session);
  const tree = ctx.terrain
    .findStatics(treeStatics, ctx.position(), 40)
    .filter((t) => !depleted.active(`${t.x},${t.y}`) && !risky(t))
    .sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b))[0];
  if (!tree) return false;
  ctx.phase('side-trade', `Chopping wood near ${tree.x},${tree.y} on the side`);
  await ctx.navigate(tree, 1).catch(() => {});
  const axe = tool(ctx, hatchets);
  // Harvesting needs the axe in hand (ServUO HarvestTarget).
  if (axe && axe.parent !== ctx.serial)
    await session.equipItem(axe.serial, ctx.terrain.tile(axe.graphic, true).layer || Layer.TwoHanded).catch(() => {});
  const cut = async () => {
    const pile = ctx.carried().find((i) => i.graphic === LOG && !i.hue);
    const blade = tool(ctx, hatchets);
    if (!pile || !blade) return;
    session.use(blade.serial);
    await session.waitFor(() => session.world.target !== null, 'hatchet cursor', 4000).catch(() => {});
    if (session.world.target) session.target({ serial: pile.serial, x: 0, y: 0, z: 0, graphic: pile.graphic });
    await Bun.sleep(1500);
  };
  const chop = await chopTree(
    {
      session,
      check: ctx.check,
      say: ctx.log,
      tool: () => tool(ctx, hatchets),
      cutBoards: cut,
      full: () => ctx.status().weight >= ctx.status().maxWeight * 0.8,
      logs: () => ctx.count(LOG),
      noted: () => {},
      describe: () => `${ctx.count(LOG)} logs`
    },
    { ...tree, id: tree.id }
  );
  if (chop.depleted || !chop.answered) depleted.set(`${tree.x},${tree.y}`, Date.now() + 30 * 60_000);
  await cut();
  if (ctx.count(BOARD) >= 40 || ctx.status().weight >= ctx.status().maxWeight * 0.7) {
    const carpenter = pickLocation(ctx.city, 'carpenter', ctx.position());
    if (carpenter) await ctx.navigate(carpenter, 4).catch(() => {});
    const sold = await sellBoards(ctx).catch(() => undefined);
    if (sold) ctx.log(`Sold ${sold.amount} boards from the side trade for ${sold.earned} gold`);
  }
  return true;
}

// One stay at a rock, then smelting and selling once the pack is heavy: true when the turn went to it.
export async function oreTurn(ctx: ProfessionContext): Promise<boolean> {
  const { session } = ctx;
  if (!tool(ctx, miningTools) && ctx.count(gold) >= 40)
    await buyTool(ctx, 'mining-tools', [...miningTools], 40).catch(() => false);
  const pick = tool(ctx, miningTools);
  if (!pick) return false;
  const area = [...workAreas('mining')].sort((a, b) => distance(a, ctx.position()) - distance(b, ctx.position()))[0];
  if (!area) return false;
  const { exhausted, newTrip, plan } = minerPlan(ctx.checkpoint, ctx.template, ctx.persist);
  const blocked = new Set<string>();
  const smeltable = (pack: number) =>
    ctx.carried(pack).filter((i) => ore.has(i.graphic) && !(i.graphic === 0x19b7 && (i.amount ?? 1) < 2));
  const heavy = () => ctx.status().weight >= ctx.status().maxWeight * 0.75;
  if (!heavy()) {
    const found = await findMiningSite({
      session,
      terrain: ctx.terrain,
      serial: ctx.serial,
      position: ctx.position,
      check: ctx.check,
      exhausted,
      blocked,
      miningArea: { x: area.x, y: area.y },
      anchor: { x: area.x, y: area.y }
    });
    if (!found) return false;
    const { site, approachRange } = found;
    ctx.phase('side-trade', `Digging ore near ${site.x},${site.y} on the side`);
    await ctx.navigate(site.floor ? site : { x: site.x, y: site.y }, approachRange).catch(() => {});
    await digSite(
      { ...ctx, home: pickLocation(ctx.city, 'banker') ?? area, exhausted, progress: { packRejected: false } },
      { backpack: ctx.backpack(), carried: ctx.carried, tool: pick.serial, site, full: heavy },
      0
    );
    if (!heavy()) return true;
  }
  // Smelted at the nearest forge (miner-smelting.ts), the iron sold to the smith.
  const unsmeltable = new Set<number>();
  const smelt = createSmelter({
    ...ctx,
    blocked,
    banks: [],
    shops: [],
    smeltable: (pack) => smeltable(pack).filter((i) => !unsmeltable.has(i.serial)),
    retainedOre: () => [],
    unsmeltable,
    plan,
    newTrip,
    progress: { smelts: 0, ingotsProduced: 0, deposits: 0, trips: 0, purchases: 0, sold: 0, packRejected: false }
  });
  await smelt(ctx.backpack()).catch((error) =>
    ctx.log(`Side-trade smelting: ${error instanceof Error ? error.message : error}`)
  );
  const earned = await sellTo(ctx, 'blacksmith', (item) => item.graphic === INGOT && !item.hue).catch(() => 0);
  if (earned) ctx.log(`Sold iron from the side trade for ${earned} gold`);
  return true;
}
