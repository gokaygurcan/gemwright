import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Areas, useAreas } from './areas';
import { grounds } from './cemeteries';
import { escortSpots } from './escort';
import { moongates } from './gates';
import type { Link } from './links';
import { allServiceLocations, type ServiceType } from './locations';
import { logger } from './log';
import type { Terrain } from './terrain';

// Which known places can be walked to from which (areas.ts): every place residents go (shops,
// banks, hunting grounds, moongates, teleporter ends, escort spots, all from the shard's world files)
// joined to its nearest neighbours by a walk on the client's own map; places a walk joins, directly
// or through others, share an area, and teleporters join the areas at their two ends. About a minute
// of walks: built once per world and map, kept on the data volume and reused at every later start.
const services: ServiceType[] = [
  'banker',
  'healer',
  'alchemist',
  'tailor',
  'blacksmith',
  'weaponsmith',
  'mage',
  'provisioner',
  'animal-trainer',
  'fisherman',
  'tinker',
  'mining-tools',
  'carpenter',
  'bowyer',
  'jeweler',
  'cook',
  'bard',
  'graveyard'
];
interface Place {
  x: number;
  y: number;
  kind: string;
}

function knownPlaces(teleporters: Link[]): Place[] {
  const places: Place[] = [];
  // Dungeons and mines (x 5120 and beyond) only by their teleporters: their levels, and the way out.
  const add = (kind: string, p: { x: number; y: number }) => {
    if (p.x >= 5120 && !kind.startsWith('teleporter')) return;
    if (!places.some((o) => o.x === p.x && o.y === p.y)) places.push({ x: p.x, y: p.y, kind });
  };
  for (const service of services) for (const p of allServiceLocations(service)) add(service, p);
  for (const g of grounds) add('ground', g.center);
  for (const [name, gate] of Object.entries(moongates)) add(`gate:${name}`, gate);
  for (const link of teleporters) {
    add('teleporter', link.from);
    add('teleporter-exit', link.to);
  }
  for (const spot of escortSpots()) add('escort', spot);
  return places;
}

export async function buildAreas(
  terrain: Terrain,
  teleporters: Link[],
  places = knownPlaces(teleporters)
): Promise<Areas> {
  // Union-find over places.
  const parent = places.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] ?? i] ?? i;
      i = parent[i] ?? i;
    }
    return i;
  };
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const at = (p: { x: number; y: number }) => places.findIndex((o) => o.x === p.x && o.y === p.y);
  const distance = (a: Place, b: Place) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const standing = (p: Place) => {
    const land = terrain.cell(p.x, p.y).land.z;
    return { x: p.x, y: p.y, z: terrain.standingZ(p.x, p.y, land) ?? land };
  };
  // Each place tries its twelve nearest within 300 tiles; pairs already joined on foot are skipped. A hunting
  // ground counts as reached within 12 tiles of its centre (its spawn spreads around it).
  const pairs: [number, number][] = [];
  places.forEach((p, i) => {
    const near = places
      .map((o, j) => ({ j, d: distance(p, o) }))
      .filter(({ j, d }) => j !== i && d <= 300)
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
    for (const { j } of near) if (i < j || !pairs.some(([a, b]) => a === j && b === i)) pairs.push([i, j]);
  });
  const work = async () => {
    for (let pair = pairs.shift(); pair; pair = pairs.shift()) {
      const [a, b] = pair;
      if (find(a) === find(b)) continue;
      const from = places[a];
      const to = places[b];
      if (!from || !to) continue;
      const range = to.kind === 'ground' ? 12 : 3;
      // Already there (a row of teleporter tiles): an empty path is no failure.
      if (distance(from, to) <= range) {
        join(a, b);
        continue;
      }
      const path = await terrain.pathAsync(standing(from), to, range).catch(() => null);
      const end = path?.at(-1);
      if (end && Math.max(Math.abs(end.x - to.x), Math.abs(end.y - to.y)) <= range) join(a, b);
    }
  };
  await Promise.all(Array.from({ length: 8 }, work));
  // Walks alone make sections (a dungeon's levels); teleporters then join sections into areas.
  const sections = places.map((_, i) => find(i));
  for (const link of teleporters) {
    const [a, b] = [at(link.from), at(link.to)];
    if (a >= 0 && b >= 0) join(a, b);
  }
  const ids = new Map<number, number>();
  const area = (i: number) => {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    return ids.get(root) ?? 0;
  };
  const points = places.map((p, i) => ({ x: p.x, y: p.y, kind: p.kind, area: area(i), section: sections[i] ?? i }));
  const areas = [...ids.values()].map((id) => ({
    id,
    gates: points.filter((p) => p.area === id && p.kind.startsWith('gate:')).map((p) => p.kind.slice(5))
  }));
  return { areas, points };
}

// The areas for this world and map: the copy on the data volume when its fingerprint (the places
// and the map files) matches, else built now, saved, and older copies removed.
export async function useShardAreas(directory: string, terrain: Terrain, assets: string, teleporters: Link[]) {
  const places = knownPlaces(teleporters);
  const hash = createHash('sha256').update(JSON.stringify(places));
  for (const name of readdirSync(assets).sort()) hash.update(`${name}:${statSync(join(assets, name)).size}`);
  const fingerprint = hash.digest('hex').slice(0, 16);
  const file = join(directory, `areas-${fingerprint}.json`);
  if (existsSync(file)) {
    useAreas(JSON.parse(readFileSync(file, 'utf8')) as Areas, fingerprint);
    return;
  }
  const started = performance.now();
  logger('areas').info(`[areas] walking between ${places.length} places to learn the land (about a minute)`);
  const areas = await buildAreas(terrain, teleporters, places);
  for (const old of readdirSync(directory).filter((name) => /^areas-[0-9a-f]+\.json$/.test(name)))
    rmSync(join(directory, old), { force: true });
  writeFileSync(file, JSON.stringify(areas));
  useAreas(areas, fingerprint);
  logger('areas').info(
    `[areas] ${areas.points.length} places in ${areas.areas.length} areas, in ${Math.round((performance.now() - started) / 1000)} s`
  );
}
