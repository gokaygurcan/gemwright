import { readFileSync } from 'node:fs';

import { Blocked } from './blocked';
import { chaosOf } from './chaos';
import type { FighterContext } from './fighter-context';
import { goldOf, readyFor } from './fighter-prey';
import { type Gate, moongates, nearestGate, travelByMoongate } from './moongate';
import { distance } from './navigation';
import { residentsNear } from './spread';

// Trammel cemeteries (uo.com "Cemeteries" list) that hold undead spawners on the pinned shard
// (Spawns/trammel.xml Graveyards#0-#5). Nujel'm has no undead spawner and is not listed.
// `gate` is the public moongate a fighter travels through when the cemetery is far away.
export interface Ground {
  name: string;
  center: { x: number; y: number };
  gate: Gate;
  patrol?: { x: number; y: number }[];
  // Overland spawns (catalogs/hunting-grounds.json): how far they reach and what lives there.
  radius?: number;
  creatures?: Record<string, number>;
}
export const cemeteries: Ground[] = [
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
// Beyond the cemeteries: every overland place where creatures that attack on sight spawn, outside
// towns and dungeons (build-grounds.ts): orcs, harpies, trolls and lizardmen west of Britain, and
// hundreds more. A fighter moves on to one its skills meet when its cemetery runs dry.
const spawnGrounds: Ground[] = (
  JSON.parse(readFileSync(new URL('../catalogs/hunting-grounds.json', import.meta.url), 'utf8')) as {
    grounds: { name: string; center: { x: number; y: number }; radius: number; creatures: Record<string, number> }[];
  }
).grounds.map((g) => ({ ...g, gate: nearestGate(g.center) }));
export const grounds: Ground[] = [...cemeteries, ...spawnGrounds];
const reach = (ground: Ground) => ground.radius ?? HUNTING_RADIUS;
// Residents at a cemetery beyond which a fighter moving on looks elsewhere.
const CROWDED = 8;
// Farther than this, a route is taken through a moongate instead of walked.
const WALKING_LIMIT = 300;

export const groundOf = (trip: FighterContext['trip']) =>
  grounds.find((ground) => ground.name === trip.ground) ?? (cemeteries[0] as Ground);

export const nearAnyGround = (point: { x: number; y: number }) =>
  grounds.some((ground) => distance(point, ground.center) < reach(ground));

export const atGround = (ctx: FighterContext) =>
  distance(ctx.position(), groundOf(ctx.trip).center) < reach(groundOf(ctx.trip));

// Four points around the ground's centre, wider on an overland spawn than in a cemetery.
export const patrolPoints = (ground: Ground) => {
  const scale = ground.radius ? ground.radius / 16 : 1;
  return (
    ground.patrol ??
    [
      [6, 10],
      [-10, 0],
      [6, -10],
      [10, 0]
    ].map(([dx, dy]) => ({
      x: ground.center.x + Math.round((dx ?? 0) * scale),
      y: ground.center.y + Math.round((dy ?? 0) * scale)
    }))
  );
};

// Where to hunt next once the current ground runs dry: the cemeteries, and every overland spawn
// whose creatures this fighter's skills meet for at least half of what lives there (fighter-prey.ts
// `readyFor`). Nearer grounds, richer ones (their loot packs' gold) and quieter ones (spread.ts)
// are preferred; with more skill the plain cemeteries lose their pull, and chaos shuffles the
// order a little. A crowded ground is passed over.
export function nextGround(ctx: FighterContext): string {
  const here = ctx.position();
  const current = groundOf(ctx.trip).name;
  const skill = Math.max(...[...ctx.session.world.skills.values()].map((s) => s.value ?? 0), 0);
  const options = grounds.flatMap((ground) => {
    const present = residentsNear(ground.center, reach(ground), ctx.serial);
    if (ground.name === current || present >= CROWDED) return [];
    const kinds = Object.entries(ground.creatures ?? {});
    const total = kinds.reduce((n, [, count]) => n + count, 0);
    const fit = kinds.filter(([type]) => readyFor(ctx, type)).reduce((n, [, count]) => n + count, 0);
    if (ground.creatures && fit * 2 < total) return [];
    const gold = kinds.reduce((n, [type, count]) => n + goldOf(type) * count, 0) / Math.max(1, total);
    const cost =
      distance(here, ground.center) +
      (ground.creatures ? 0 : Math.max(0, skill - 60) * 8) +
      present * 40 -
      Math.min(gold, 300) * 3 +
      Math.random() * 300 * chaosOf(ctx.session);
    return [{ name: ground.name, cost }];
  });
  return options.sort((a, b) => a.cost - b.cost)[0]?.name ?? 'Britain';
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
  ctx.phase(
    'travelling-to-graveyard',
    `Heading to ${ground.creatures ? `the ${ground.name}` : `the ${ground.name} cemetery`}`
  );
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
