import { Blocked } from './blocked';
import type { FighterContext } from './fighter-context';
import { type Gate, moongates, nearestGate, travelByMoongate } from './moongate';
import { distance } from './navigation';
import { residentsNear } from './spread';

// Trammel cemeteries (uo.com "Cemeteries" list) that hold undead spawners on the pinned shard
// (Spawns/trammel.xml Graveyards#0-#5). Nujel'm has no undead spawner and is not listed.
// `gate` is the public moongate a fighter travels through when the cemetery is far away.
export const cemeteries: {
  name: string;
  center: { x: number; y: number };
  gate: Gate;
  patrol?: { x: number; y: number }[];
}[] = [
  {
    name: 'Britain',
    center: { x: 1369, y: 1475 },
    gate: 'britain',
    patrol: [
      { x: 1375, y: 1485 },
      { x: 1355, y: 1475 },
      { x: 1375, y: 1455 },
      { x: 1395, y: 1475 }
    ]
  },
  { name: 'Vesper', center: { x: 2758, y: 867 }, gate: 'minoc' },
  { name: 'Yew', center: { x: 722, y: 1119 }, gate: 'yew' },
  { name: 'Jhelom', center: { x: 1285, y: 3731 }, gate: 'jhelom' },
  { name: 'Moonglow', center: { x: 4545, y: 1317 }, gate: 'moonglow' },
  // Liches spawn here; the opponent gate keeps ordinary fighters away from them.
  { name: 'Cove', center: { x: 2438, y: 1099 }, gate: 'minoc' }
];
const HUNTING_RADIUS = 65;
// Residents at a cemetery beyond which a fighter moving on looks elsewhere.
const CROWDED = 8;
// Farther than this, a route is taken through a moongate instead of walked.
const WALKING_LIMIT = 300;

export const groundOf = (trip: FighterContext['trip']) =>
  cemeteries.find((cemetery) => cemetery.name === trip.ground) ?? (cemeteries[0] as (typeof cemeteries)[number]);

export const nearAnyGround = (point: { x: number; y: number }) =>
  cemeteries.some((cemetery) => distance(point, cemetery.center) < HUNTING_RADIUS);

export const atGround = (ctx: FighterContext) => distance(ctx.position(), groundOf(ctx.trip).center) < HUNTING_RADIUS;

export const patrolPoints = (ground: (typeof cemeteries)[number]) =>
  ground.patrol ??
  [
    [6, 10],
    [-10, 0],
    [6, -10],
    [10, 0]
  ].map(([dx, dy]) => ({ x: ground.center.x + (dx ?? 0), y: ground.center.y + (dy ?? 0) }));

// Gradual spread: everyone starts at Britain; a fighter that keeps finding nothing to fight moves on
// to the next cemetery in its own temperament-based order, so a crowd fans out over time.
export function nextGround(ctx: FighterContext): string {
  const others = cemeteries.slice(1);
  const offset = ctx.template.behavior.temperament?.patrolOffset ?? 0;
  const order = [cemeteries[0], ...others.slice(offset % others.length), ...others.slice(0, offset % others.length)];
  const index = order.findIndex((cemetery) => cemetery?.name === groundOf(ctx.trip).name);
  // In that order, the next cemetery not already crowded with residents (spread.ts).
  for (let step = 1; step < order.length; step++) {
    const next = order[(index + step) % order.length];
    if (next && residentsNear(next.center, HUNTING_RADIUS, ctx.serial) < CROWDED) return next.name;
  }
  return order[(index + 1) % order.length]?.name ?? 'Britain';
}

// Reaches a far point the way a player would: through the moongate nearest to it, then on foot.
export async function travelNear(ctx: FighterContext, point: { x: number; y: number }, range: number) {
  const gate = nearestGate(point);
  const viaGate = async () => {
    if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
  };
  if (distance(ctx.position(), point) > WALKING_LIMIT) await viaGate();
  try {
    await ctx.navigate(point, range);
  } catch (error) {
    // Close but across water (an island town from the shore): take the gate, then walk.
    if (!(error instanceof Blocked) || error.reason !== 'unreachable' || distance(ctx.position(), moongates[gate]) <= 2)
      throw error;
    await viaGate();
    await ctx.navigate(point, range);
  }
}

export async function travelToGround(ctx: FighterContext, overland = false) {
  const ground = groundOf(ctx.trip);
  ctx.phase('travelling-to-graveyard', `Heading to the ${ground.name} cemetery`);
  if (!overland && distance(ctx.position(), ground.center) > WALKING_LIMIT) await travelByMoongate(ctx, ground.gate);
  try {
    await ctx.navigate(ground.center, 3);
  } catch (error) {
    // A cemetery across water from here: through its moongate, then on foot.
    if (overland || !(error instanceof Blocked) || error.reason !== 'unreachable') throw error;
    await travelByMoongate(ctx, ground.gate);
    await ctx.navigate(ground.center, 3);
  }
}

// Town trips (bank, vendors, healer) go to the fighter's home town; from a distant cemetery the
// way back is the moongate nearest home.
export async function returnHome(ctx: FighterContext) {
  const home = ctx.home.town;
  if (distance(ctx.position(), home) <= WALKING_LIMIT) return;
  const gate = nearestGate(home);
  if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
}
