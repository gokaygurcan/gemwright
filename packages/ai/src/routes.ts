import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { banks, harvestTiles, moongateList, npcTypes } from '@gemwright/common/game/rules';

import { logger } from './log';
import { PathPool } from './path-pool';
import { RouteSearch } from './path-search';
import { packageRoot } from './paths';
import type { Corridor } from './route-waypoints';
import type { ShardWorld, Town } from './spawns';
import type { Point, Terrain } from './terrain';

type Hub = { name: string; x: number; y: number; city?: string };
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const gap = (at: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }) =>
  Math.max(r.x - at.x, at.x - (r.x + r.width - 1), r.y - at.y, at.y - (r.y + r.height - 1), 0);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// The town a spot belongs to: the one whose region it is in, else the nearest within 250 tiles.
function townAt(towns: readonly Town[], at: { x: number; y: number }) {
  let best = '';
  let nearest = 250;
  for (const town of towns)
    for (const rect of town.rects) {
      const d = gap(at, rect);
      if (d < nearest) {
        nearest = d;
        best = town.name;
      }
    }
  return best;
}

// Each town's bankers, where their spawners keep them (within 12 tiles), in the order the shard lists them.
const bankers = new Set(npcTypes.filter((npc) => banks(npc)).map((npc) => npc.toLowerCase()));
function banksOf(world: ShardWorld) {
  const found = new Map<string, Hub[]>();
  for (const spawner of world.spawners) {
    if (spawner.map !== 'Trammel' || spawner.range > 12 || !spawner.kinds.some((kind) => bankers.has(kind))) continue;
    const city = townAt(world.towns, spawner);
    if (!city) continue;
    const list = found.get(city.toLowerCase()) ?? [];
    list.push({ name: `bank:${city}`, x: spawner.x, y: spawner.y, city });
    found.set(city.toLowerCase(), list);
  }
  return found;
}

// Each town's share of mining and woods (world/world.json `workAreas`).
const weights = (
  JSON.parse(readFileSync(new URL('world/world.json', packageRoot), 'utf8')) as {
    workAreas: { mining: Record<string, number>; woods: Record<string, number> };
  }
).workAreas;
const rock = new Set(harvestTiles.rock.land);
const trees = new Set(harvestTiles.trees.statics);
const RADIUS = 300;

// Where tiles crowd most near a bank: 16-tile blocks scored by the tiles in and around them, nearer
// blocks first; the centre is the middle of that crowd.
function densest(points: { x: number; y: number }[], bank: { x: number; y: number }) {
  const blocks = new Map<string, { x: number; y: number }[]>();
  for (const p of points) {
    const key = `${p.x >> 4},${p.y >> 4}`;
    const block = blocks.get(key) ?? [];
    block.push(p);
    blocks.set(key, block);
  }
  let best: { score: number; around: { x: number; y: number }[] } | undefined;
  for (const key of blocks.keys()) {
    const [bx = 0, by = 0] = key.split(',').map(Number);
    const around = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => blocks.get(`${bx + dx},${by + dy}`) ?? []));
    const score = around.length / (1 + distance({ x: bx * 16 + 8, y: by * 16 + 8 }, bank) / 150);
    if (!best || score > best.score) best = { score, around };
  }
  return best && { x: median(best.around.map((p) => p.x)), y: median(best.around.map((p) => p.y)) };
}

// Each weighted town's mines (ServUO Mining.cs mountain and cave land) and woods (Lumberjacking.cs
// trees) from the client's map, near its bank.
function workAreas(terrain: Terrain, bank: (city: string) => Hub | undefined) {
  const areas = (kind: 'mining' | 'woods', tiles: (at: { x: number; y: number }) => { x: number; y: number }[]) =>
    Object.keys(weights[kind]).flatMap((city) => {
      const at = bank(city);
      const centre = at && densest(tiles(at), at);
      return centre ? [{ city, ...centre }] : [];
    });
  return [
    ...areas('mining', (at) => {
      const found: { x: number; y: number }[] = [];
      for (let x = Math.max(1, at.x - RADIUS); x <= Math.min(5119, at.x + RADIUS); x++)
        for (let y = Math.max(1, at.y - RADIUS); y <= Math.min(4095, at.y + RADIUS); y++)
          if (rock.has(terrain.cell(x, y).land.id)) found.push({ x, y });
      return found;
    }),
    ...areas('woods', (at) => terrain.findStatics(trees, { ...at, z: 0 }, RADIUS))
  ];
}

// The public roads residents follow on long walks: each town's bank to its moongate, to its mines
// and woods, and to the two nearest other banks, for the towns residents are kept to.
function hubPairs(world: ShardWorld, terrain: Terrain, cities: readonly string[] | undefined): [Hub, Hub][] {
  const allowed = (city: string) => !cities?.length || cities.some((c) => c.toLowerCase() === city.toLowerCase());
  const byTown = banksOf(world);
  const banks = new Map<string, Hub>();
  for (const [city, list] of byTown) {
    const first = list[0];
    if (first?.city && allowed(first.city) && !banks.has(city)) banks.set(city, first);
  }
  const gates: Hub[] = Object.entries(moongateList).map(([name, gate]) => ({
    name: `gate:${name}`,
    x: gate.x,
    y: gate.y
  }));
  const work = workAreas(terrain, (city) => byTown.get(city.toLowerCase())?.[0]);
  const pairs: [Hub, Hub][] = [];
  const add = (a: Hub, b: Hub) => {
    if (a.name !== b.name && !pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) pairs.push([a, b]);
  };
  for (const bank of banks.values()) {
    const gate = [...gates].sort((a, b) => distance(bank, a) - distance(bank, b))[0];
    if (gate && distance(bank, gate) <= 400) add(bank, gate);
    for (const area of work.filter((a) => a.city === bank.city))
      add(bank, { name: `work:${area.city}:${area.x},${area.y}`, x: area.x, y: area.y });
    const others = [...banks.values()].filter((other) => other !== bank && distance(bank, other) <= 1000);
    for (const other of others.sort((a, b) => distance(bank, a) - distance(bank, b)).slice(0, 2)) add(bank, other);
  }
  return pairs;
}

function buildCorridors(terrain: Terrain, pairs: [Hub, Hub][]): Corridor[] {
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

// The roads for these hubs and this map: the copy on the data volume when its fingerprint matches,
// else walked now (a minute or two), saved, and older copies removed.
export function useRoutes(
  directory: string,
  world: ShardWorld,
  terrain: Terrain,
  assets: string,
  cities: readonly string[] | undefined
) {
  const pairs = hubPairs(world, terrain, cities);
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
