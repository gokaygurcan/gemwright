// Trammel's teleporters (the shard's Data/teleporters.csv, read at start by useTeleporters): Jhelom's
// islands are joined only by them, and dungeons and mines (x 5120 and beyond) are entered and left by
// them (New Haven's mine entrance 3508,2777 to 5912,355 and back). Route searches never step on one by accident (terrain.ts blocks their
// tiles unless one is the goal), and a walk with no route on foot takes the one whose far end
// brings it nearer its goal (navigation.ts).
// Kept here, not imported from navigation.ts: navigation and direct-route.ts import this module.
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export interface Link {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}
const links: Link[] = [];
// Entrance tiles (`x,y`), never stepped on by accident.
export const teleporterTiles = new Set<string>();

// Data/teleporters.csv rows (`x,y,z,map,x,y,z,map,twoWay`): the Trammel ones; a two-way row gives
// both directions.
export function parseTeleporters(csv: string): Link[] {
  const found: Link[] = [];
  for (const line of csv.split('\n')) {
    const f = line.trim().split(',');
    if (line.startsWith('#') || f.length < 9 || f[3] !== 'Trammel' || f[7] !== 'Trammel') continue;
    const from = { x: Number(f[0]), y: Number(f[1]), z: Number(f[2]) };
    const to = { x: Number(f[4]), y: Number(f[5]), z: Number(f[6]) };
    found.push({ from, to });
    if (f[8] === 'True') found.push({ from: to, to: from });
  }
  return found;
}
export const allLinks = (): readonly Link[] => links;
export function useTeleporters(found: Link[]) {
  links.splice(0, links.length, ...found);
  teleporterTiles.clear();
  for (const link of found) teleporterTiles.add(`${link.from.x},${link.from.y}`);
}

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
