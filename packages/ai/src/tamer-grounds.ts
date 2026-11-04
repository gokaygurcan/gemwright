import { creatures } from '@gemwright/common/game/rules';

import { absence } from './absence';
import { onHaven } from './haven';
import { distance } from './navigation';
import { alive } from './spawn-grounds';
import type { Spawner } from './spawns';
import { placeAllowed } from './towns';
import { tuning } from './tuning';
import { reachableFrom } from './unreachable';

// Where tamable animals live on Trammel, from the shard's own spawners at start (useTamingSpawns):
// spawners grouped by 48-tile cell, a kind counted in a cell with at least three of it. A spawner
// says what may be there, not what is: a ground found empty is given up for a while. A tamer heads for a ground holding animals it can learn
// from (ServUO gains while MinTameSkill is near its own skill), picked at random among the nearer
// ones, searches there, and gives the ground up for an hour once it finds nothing worth taming.
interface Ground {
  center: { x: number; y: number };
  radius: number;
  creatures: Record<string, { count: number; minTame: number }>;
}
const tamable = new Map(
  creatures.flatMap((c) =>
    c.minTame === undefined ? [] : [[c.type.toLowerCase(), { type: c.type, minTame: c.minTame }] as const]
  )
);
const CELL = 48;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const grounds: Ground[] = [];
export function useTamingSpawns(spawners: Spawner[]) {
  const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
  for (const spawner of spawners) {
    const { x, y } = spawner;
    const kinds = alive(spawner, (type) => tamable.has(type));
    if (spawner.map !== 'Trammel' || x >= 5120 || !kinds.length) continue;
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const cell = cells.get(key) ?? { xs: [], ys: [], kinds: new Map<string, number>() };
    cells.set(key, cell);
    cell.xs.push(x);
    cell.ys.push(y);
    for (const [type, count] of kinds) cell.kinds.set(type, (cell.kinds.get(type) ?? 0) + count);
  }
  const built = [...cells.values()]
    .map((cell) => ({
      center: { x: median(cell.xs), y: median(cell.ys) },
      radius: CELL / 2,
      creatures: Object.fromEntries(
        [...cell.kinds]
          .filter(([, count]) => count >= 3)
          .map(([type, count]) => {
            const c = tamable.get(type);
            return [c?.type ?? type, { count, minTame: c?.minTame ?? 0 }];
          })
      )
    }))
    .filter((ground) => Object.keys(ground.creatures).length);
  grounds.splice(0, grounds.length, ...built);
}
const EMPTY_SEARCHES = tuning.taming.emptySearches;
const current = new Map<number, { ground: Ground; searches: number }>();

const worth = (ground: Ground, skill: number) =>
  Object.values(ground.creatures).reduce(
    (n, c) => n + (c.minTame <= skill + 5 && c.minTame >= skill - 15 ? c.count : 0),
    0
  );

// The point to search next, or undefined when no ground in the catalog suits this skill.
export function tamingSpot(me: number, at: { x: number; y: number }, skill: number, young = false) {
  const given = absence(me);
  let stay = current.get(me);
  if (
    stay &&
    (stay.searches >= EMPTY_SEARCHES || !worth(stay.ground, skill) || !reachableFrom(stay.ground.center, at))
  ) {
    given.note('tamable', stay.ground.center);
    current.delete(me);
    stay = undefined;
  }
  if (!stay) {
    const options = grounds
      .filter(
        (g) =>
          worth(g, skill) > 0 &&
          !given.seen('tamable', g.center) &&
          placeAllowed(g.center) &&
          reachableFrom(g.center, at)
      )
      // A Young resident of New Haven prefers Haven Island's grounds (haven.ts), free to go further.
      .map((g) => ({
        g,
        cost: distance(at, g.center) / Math.sqrt(worth(g, skill)) + (young && !onHaven(g.center) ? 300 : 0)
      }))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, 5);
    const pick = options[Math.floor(Math.random() * options.length)];
    if (!pick) return undefined;
    stay = { ground: pick.g, searches: 0 };
    current.set(me, stay);
  }
  const { center, radius } = stay.ground;
  // Searches count only once there: the walk is not a search.
  if (distance(at, center) <= radius * 2) stay.searches++;
  return {
    x: center.x + Math.round((Math.random() - 0.5) * 2 * radius),
    y: center.y + Math.round((Math.random() - 0.5) * 2 * radius),
    far: distance(at, center) > radius * 2
  };
}

// Something worth taming turned up: the ground keeps its tamer.
export const foundAtGround = (me: number) => {
  const stay = current.get(me);
  if (stay) stay.searches = 0;
};

export function unreachableGround(me: number) {
  const stay = current.get(me);
  if (!stay) return;
  absence(me).note('tamable', stay.ground.center);
  current.delete(me);
}
