import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RouteSearch } from './path-search';
import { type Point, Terrain } from './terrain';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { assets: { type: 'string' }, output: { type: 'string' } }
});
if (!values.assets || !values.output) throw new Error('--assets and --output are required');
const terrain = Terrain.shared(resolve(values.assets), 1);
// The larger workspace is only for this offline public-map build, never for live sessions.
// Off-road steps cost two road steps, so corridors keep to the roads between towns.
const search = new RouteSearch(1048576, 60000, 4000000, 2);
const hubs = {
  bank: { x: 1434, y: 1694, z: 0 },
  britain: { x: 1369, y: 1475, z: 0 },
  britainGate: { x: 1336, y: 1997, z: 5 },
  yewGate: { x: 771, y: 752, z: 5 },
  yew: { x: 722, y: 1119, z: 0 },
  northwest: { x: 1100, y: 1207, z: 2 },
  minocGate: { x: 2701, y: 692, z: 5 },
  vesper: { x: 2758, y: 867, z: 0 },
  cove: { x: 2438, y: 1099, z: 0 },
  minocBank: { x: 2503, y: 552, z: 0 },
  mine: { x: 2561, y: 502, z: 0 },
  woods: { x: 1230, y: 1470, z: 0 },
  jhelomGate: { x: 1499, y: 3771, z: 5 },
  jhelom: { x: 1285, y: 3731, z: 0 },
  moonglowGate: { x: 4467, y: 1283, z: 5 },
  moonglow: { x: 4545, y: 1317, z: 0 },
  trinsic: { x: 1823, y: 2821, z: 0 }
} satisfies Record<string, Point>;
const pairs: [keyof typeof hubs, keyof typeof hubs][] = [
  ['bank', 'britain'],
  ['bank', 'britainGate'],
  ['bank', 'woods'],
  ['yewGate', 'yew'],
  ['yew', 'britain'],
  ['northwest', 'britain'],
  ['northwest', 'yew'],
  ['northwest', 'yewGate'],
  ['minocGate', 'vesper'],
  ['minocGate', 'cove'],
  ['minocBank', 'mine'],
  ['minocGate', 'minocBank'],
  ['jhelomGate', 'jhelom'],
  ['moonglowGate', 'moonglow'],
  ['bank', 'cove'],
  ['cove', 'vesper'],
  ['vesper', 'minocBank'],
  ['bank', 'trinsic']
];
const corridors: { name: string; both: boolean; points: number[][] }[] = [];
const startFor = (point: Point) => {
  for (let offset = 0; offset <= 64; offset += 2) {
    for (const z of offset ? [point.z + offset, point.z - offset] : [point.z]) {
      const standing = terrain.stand(point.x, point.y, z);
      if (standing) return standing;
    }
  }
  throw new Error(`No public standing surface at ${point.x},${point.y}`);
};
for (const [a, b] of pairs) {
  const from = startFor(hubs[a]);
  const to = startFor(hubs[b]);
  const make = (start: Point, goal: Point) => {
    const result = search.run(terrain, { start, goal, range: 1, blocked: [] });
    if (!result.path?.length)
      throw new Error(`Offline route failed ${a} to ${b}: ${JSON.stringify({ ...result, path: undefined })}`);
    console.log(
      `${a} -> ${b}: ${result.path.length} steps, ${result.expanded} expansions, ${Math.round(result.elapsedMs)}ms`
    );
    return [start, ...result.path];
  };
  const full = make(from, to);
  const reverse = [...full].reverse();
  const both = reverse.slice(1).every((point, index) => {
    const previous = reverse[index];
    return !!previous && terrain.standingZ(point.x, point.y, previous.z, previous) === point.z;
  });
  const coarse = (path: Point[]) =>
    path
      .filter((_, index) => index % 24 === 0 || index === path.length - 1)
      .map((point) => [point.x, point.y, point.z]);
  corridors.push({ name: `${a}-${b}`, both, points: coarse(full) });
  if (!both) corridors.push({ name: `${b}-${a}`, both: false, points: coarse(make(to, from)) });
}
const json = `${JSON.stringify({ schemaVersion: 1, facet: 1, stride: 24, corridors })}\n`;
if (Buffer.byteLength(json) > 20000) throw new Error('Generated corridor file exceeds the authored-file limit');
writeFileSync(resolve(values.output), json);
console.log(`Wrote ${corridors.length} public-terrain corridors, ${Buffer.byteLength(json)} bytes`);
