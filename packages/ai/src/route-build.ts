import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { moongates } from './gates';
import { allServiceLocations } from './locations';
import { logger } from './log';
import { PathPool } from './path-pool';
import { RouteSearch } from './path-search';
import type { Corridor } from './route-waypoints';
import type { Point, Terrain } from './terrain';
import { workAreas } from './work-areas';
import { cityAllowed } from './world';

type Hub = { name: string; x: number; y: number; city?: string };
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// The public roads residents follow on long walks: each town's bank to its moongate, to its mines
// and woods, and to the two nearest other banks, for the towns residents may go to.
function hubPairs(): [Hub, Hub][] {
  const banks = new Map<string, Hub>();
  for (const bank of allServiceLocations('banker'))
    if (cityAllowed(bank.city) && !banks.has(bank.city))
      banks.set(bank.city, { name: `bank:${bank.city}`, x: bank.x, y: bank.y, city: bank.city });
  const gates: Hub[] = Object.entries(moongates).map(([name, gate]) => ({
    name: `gate:${name}`,
    x: gate.x,
    y: gate.y
  }));
  const pairs: [Hub, Hub][] = [];
  const add = (a: Hub, b: Hub) => {
    if (a.name !== b.name && !pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) pairs.push([a, b]);
  };
  for (const bank of banks.values()) {
    const gate = [...gates].sort((a, b) => distance(bank, a) - distance(bank, b))[0];
    if (gate && distance(bank, gate) <= 400) add(bank, gate);
    for (const area of [...workAreas('mining'), ...workAreas('woods')].filter((a) => a.city === bank.city))
      add(bank, { name: `work:${area.city}:${area.x},${area.y}`, x: area.x, y: area.y });
    const others = [...banks.values()].filter((other) => other !== bank && distance(bank, other) <= 1000);
    for (const other of others.sort((a, b) => distance(bank, a) - distance(bank, b)).slice(0, 2)) add(bank, other);
  }
  return pairs;
}

export function buildCorridors(terrain: Terrain, pairs: [Hub, Hub][]): Corridor[] {
  // A large workspace for these few long walks only; off-road steps cost two road steps, so the
  // corridors keep to the roads between towns.
  const search = new RouteSearch(1048576, 60000, 4000000, 2);
  // The nearest standing spot to a hub: a mine's or a wood's centre is often rock or a trunk.
  const stand = (point: Hub): Point | undefined => {
    for (let ring = 0; ring <= 16; ring++)
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const land = terrain.cell(point.x + dx, point.y + dy).land.z;
          for (const z of [0, 10, -10, 20, -20, 40]) {
            const standing = terrain.stand(point.x + dx, point.y + dy, land + z);
            if (standing) return standing;
          }
        }
    return undefined;
  };
  const coarse = (path: Point[]) =>
    path.filter((_, index) => index % 24 === 0 || index === path.length - 1).map((p) => [p.x, p.y, p.z]);
  const corridors: Corridor[] = [];
  for (const [a, b] of pairs) {
    const from = stand(a);
    const to = stand(b);
    if (!from || !to) continue;
    const walk = (start: Point, goal: Point) => search.run(terrain, { start, goal, range: 1, blocked: [] }).path;
    const path = walk(from, to);
    if (!path?.length) continue;
    const full = [from, ...path];
    const reverse = [...full].reverse();
    const both = reverse.slice(1).every((point, index) => {
      const previous = reverse[index];
      return !!previous && terrain.standingZ(point.x, point.y, previous.z, previous) === point.z;
    });
    corridors.push({ name: `${a.name}-${b.name}`, both, points: coarse(full) });
    const back = both ? undefined : walk(to, from);
    if (back?.length) corridors.push({ name: `${b.name}-${a.name}`, both: false, points: coarse([to, ...back]) });
  }
  return corridors;
}

// The corridors for these hubs and this map: the copy on the data volume when its fingerprint
// matches, else walked now (a minute or two), saved, and older copies removed.
export function useShardRoutes(directory: string, terrain: Terrain, assets: string) {
  const pairs = hubPairs();
  const hash = createHash('sha256').update(JSON.stringify(pairs));
  for (const name of readdirSync(assets).sort()) hash.update(`${name}:${statSync(join(assets, name)).size}`);
  const file = join(directory, `routes-${hash.digest('hex').slice(0, 16)}.json`);
  if (existsSync(file)) return PathPool.useCorridors(JSON.parse(readFileSync(file, 'utf8')) as Corridor[]);
  const started = performance.now();
  logger('routes').info(`[routes] walking ${pairs.length} public roads between banks, moongates and work`);
  const corridors = buildCorridors(terrain, pairs);
  for (const old of readdirSync(directory).filter((name) => /^routes-[0-9a-f]+\.json$/.test(name)))
    rmSync(join(directory, old), { force: true });
  writeFileSync(file, JSON.stringify(corridors));
  PathPool.useCorridors(corridors);
  logger('routes').info(
    `[routes] ${corridors.length} corridors in ${Math.round((performance.now() - started) / 1000)} s`
  );
}
