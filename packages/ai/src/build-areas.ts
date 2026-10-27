import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import './run-session';
import { grounds } from './cemeteries';
import { allServiceLocations, type ServiceType } from './locations';
import { moongates } from './moongate';
import { Terrain } from './terrain';

// Offline build of locations/areas.json: which places can be walked to from which (the
// life-goal plan, ROADMAP.md step 3). Every place residents go (shops, banks, hunting grounds,
// moongates, teleporter ends, escort spots) is joined to its nearest neighbours by a walk on the
// client's own map; places a walk joins, directly or through others, share an area. Teleporters
// join the areas at their two ends. A moongate makes its area one of the gate network's.
//   bun packages/ai/src/build-areas.ts --assets <client files> [--output packages/ai/locations/areas.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { assets: { type: 'string' }, output: { type: 'string' } }
});
if (!values.assets) throw new Error('--assets is required');
const terrain = Terrain.shared(resolve(values.assets), 1);

interface Place {
  x: number;
  y: number;
  kind: string;
}
const places: Place[] = [];
const add = (kind: string, p: { x: number; y: number }) => {
  if (p.x >= 5120) return;
  if (!places.some((o) => o.x === p.x && o.y === p.y)) places.push({ x: p.x, y: p.y, kind });
};
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
for (const service of services) for (const p of allServiceLocations(service)) add(service, p);
for (const g of grounds) add('ground', g.center);
for (const [name, gate] of Object.entries(moongates)) add(`gate:${name}`, gate);
const json = <T>(path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const links = json<{ links: { from: { x: number; y: number }; to: { x: number; y: number } }[] }>(
  '../locations/teleporters.json'
).links;
for (const link of links) {
  add('teleporter', link.from);
  add('teleporter-exit', link.to);
}
for (const spot of json<{ spots: { x: number; y: number }[] }>('../locations/escorts.json').spots) add('escort', spot);

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
for (const link of links) join(at(link.from), at(link.to));

const distance = (a: Place, b: Place) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const standing = (p: Place) => {
  const land = terrain.cell(p.x, p.y).land.z;
  return { x: p.x, y: p.y, z: terrain.standingZ(p.x, p.y, land) ?? land };
};
// Each place tries its twelve nearest within 300 tiles; pairs already joined are skipped. A hunting
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
let done = 0;
const started = performance.now();
const work = async () => {
  for (let pair = pairs.shift(); pair; pair = pairs.shift()) {
    const [a, b] = pair;
    done++;
    if (find(a) === find(b)) continue;
    const from = places[a];
    const to = places[b];
    if (!from || !to) continue;
    const range = to.kind === 'ground' ? 12 : 3;
    const path = await terrain.pathAsync(standing(from), to, range).catch(() => null);
    const end = path?.at(-1);
    if (end && Math.max(Math.abs(end.x - to.x), Math.abs(end.y - to.y)) <= range) join(a, b);
    if (done % 200 === 0) console.log(`${done} walks tried, ${Math.round((performance.now() - started) / 1000)} s`);
  }
};
await Promise.all(Array.from({ length: 8 }, work));

const ids = new Map<number, number>();
const area = (i: number) => {
  const root = find(i);
  if (!ids.has(root)) ids.set(root, ids.size);
  return ids.get(root) ?? 0;
};
const points = places.map((p, i) => ({ x: p.x, y: p.y, kind: p.kind, area: area(i) }));
const areas = [...ids.values()].map((id) => {
  const inside = points.filter((p) => p.area === id);
  return {
    id,
    places: inside.length,
    gates: inside.filter((p) => p.kind.startsWith('gate:')).map((p) => p.kind.slice(5)),
    banks: inside.filter((p) => p.kind === 'banker').length,
    grounds: inside.filter((p) => p.kind === 'ground').length
  };
});
const output = resolve(values.output ?? new URL('../locations/areas.json', import.meta.url).pathname);
writeFileSync(
  output,
  `{"schemaVersion":1,"source":"client map (walks between known places), locations/teleporters.json","areas":[\n${areas
    .map((a) => `  ${JSON.stringify(a)}`)
    .join(',\n')}\n],"points":[\n${points.map((p) => `  ${JSON.stringify(p)}`).join(',\n')}\n]}\n`
);
console.log(
  `${points.length} places in ${areas.length} areas (${areas.filter((a) => a.gates.length).length} with a moongate) written to ${output}`
);
process.exit(0);
