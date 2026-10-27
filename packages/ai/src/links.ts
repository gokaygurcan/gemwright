import { readFileSync } from 'node:fs';

// Overland teleporters (locations/teleporters.json, built from ServUO's Data/teleporters.csv): Jhelom's islands
// are joined only by them. Route searches never step on one by accident (terrain.ts blocks their
// tiles unless one is the goal), and a walk with no route on foot takes the one whose far end
// brings it nearer its goal (navigation.ts).
// Kept here, not imported from navigation.ts: navigation and direct-route.ts import this module.
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export interface Link {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}
const links = (
  JSON.parse(readFileSync(new URL('../locations/teleporters.json', import.meta.url), 'utf8')) as { links: Link[] }
).links;
export const teleporterTiles = links.map((link) => `${link.from.x},${link.from.y}`);

// The link to take from `here` toward `goal`: its entrance within reach, its exit well nearer.
// One that leads back to where the walk began (`start`) would only undo the last one.
export function linkToward(
  here: { x: number; y: number },
  goal: { x: number; y: number },
  tried: Set<Link>,
  start?: { x: number; y: number }
) {
  return links
    .filter(
      (link) =>
        !tried.has(link) &&
        distance(here, link.from) <= 150 &&
        distance(link.to, goal) < distance(here, goal) - 20 &&
        !(start && distance(here, start) > 30 && distance(link.to, start) <= 30)
    )
    .sort((a, b) => distance(here, a.from) + distance(a.to, goal) - (distance(here, b.from) + distance(b.to, goal)))[0];
}
