import { readFileSync } from 'node:fs';

import { onHaven } from './haven';
import { lasting } from './lasting';
import { distance } from './navigation';
import { tuning } from './tuning';
import { reachableFrom } from './unreachable';

// Where tamable animals live on Trammel (catalogs/taming-grounds.json, built from a world save by
// packages/analyze/src/build-taming.ts). A tamer heads for a ground holding animals it can learn
// from (ServUO gains while MinTameSkill is near its own skill), picked at random among the nearer
// ones, searches there, and gives the ground up for an hour once it finds nothing worth taming.
interface Ground {
  center: { x: number; y: number };
  radius: number;
  creatures: Record<string, { count: number; minTame: number }>;
}
const grounds = (
  JSON.parse(readFileSync(new URL('../catalogs/taming-grounds.json', import.meta.url), 'utf8')) as {
    grounds: Ground[];
  }
).grounds;
const EMPTY_SEARCHES = tuning.taming.emptySearches;
const current = new Map<number, { ground: Ground; searches: number }>();

const worth = (ground: Ground, skill: number) =>
  Object.values(ground.creatures).reduce(
    (n, c) => n + (c.minTame <= skill + 5 && c.minTame >= skill - 15 ? c.count : 0),
    0
  );

// The point to search next, or undefined when no ground in the catalog suits this skill.
export function tamingSpot(me: number, at: { x: number; y: number }, skill: number, confined = false) {
  const given = lasting('taming-ground', me);
  const key = (g: Ground) => `${g.center.x},${g.center.y}`;
  let stay = current.get(me);
  if (
    stay &&
    (stay.searches >= EMPTY_SEARCHES || !worth(stay.ground, skill) || !reachableFrom(stay.ground.center, at))
  ) {
    given.set(key(stay.ground), Date.now() + tuning.taming.givenUpHours * 3_600_000);
    stay = undefined;
  }
  if (!stay) {
    const options = grounds
      // A Young resident of New Haven tames only on Haven Island (haven.ts).
      .filter(
        (g) =>
          worth(g, skill) > 0 &&
          !given.active(key(g)) &&
          reachableFrom(g.center, at) &&
          (!confined || onHaven(g.center))
      )
      .map((g) => ({ g, cost: distance(at, g.center) / Math.sqrt(worth(g, skill)) }))
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
