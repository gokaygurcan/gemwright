import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readSpawners, shares } from './spawns';

// Offline build of catalogs/taming-grounds.json from ServUO's Trammel spawners: where the tamable
// creatures live, so a tamer goes where animals of its level are instead of searching at random.
// Spawners are grouped by 48-tile cell; a kind counts in a cell with at least three spawned there.
//   bun packages/ai/src/build-taming.ts --servuo <ServUO> [--output packages/ai/catalogs/taming-grounds.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const { creatures } = JSON.parse(readFileSync(new URL('../catalogs/tamables.json', import.meta.url), 'utf8')) as {
  creatures: { type: string; minTame: number }[];
};
const byType = new Map(creatures.map((c) => [c.type.toLowerCase(), c]));
const CELL = 48;
const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
for (const spawner of readSpawners(resolve(values.servuo))) {
  const { x, y } = spawner;
  const tamable = shares(spawner).filter((k) => byType.has(k.type));
  if (spawner.map !== 'Trammel' || x >= 5120 || !tamable.length) continue;
  const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const cell = cells.get(key) ?? { xs: [], ys: [], kinds: new Map<string, number>() };
  cells.set(key, cell);
  cell.xs.push(x);
  cell.ys.push(y);
  for (const k of tamable) cell.kinds.set(k.type, (cell.kinds.get(k.type) ?? 0) + k.count);
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const grounds = [...cells.values()]
  .map((cell) => ({
    center: { x: median(cell.xs), y: median(cell.ys) },
    radius: CELL / 2,
    creatures: Object.fromEntries(
      [...cell.kinds]
        .filter(([, count]) => count >= 3)
        .map(([type, count]) => {
          const c = byType.get(type);
          return [c?.type ?? type, { count, minTame: c?.minTame ?? 0 }];
        })
    )
  }))
  .filter((ground) => Object.keys(ground.creatures).length)
  .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
const output = resolve(values.output ?? new URL('../catalogs/taming-grounds.json', import.meta.url).pathname);
const source = 'ServUO Spawns/trammel.xml (tamable creatures by 48-tile cell)';
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, source, grounds }, null, 1)}\n`);
console.log(`${grounds.length} taming grounds written to ${output}`);
