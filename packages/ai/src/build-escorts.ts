import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readSpawners } from './spawns';

// Offline build of locations/escorts.json from ServUO's Trammel spawners: where the escortable
// NPCs (BaseEscortable and its kinds) appear, for residents who take escort quests (escort.ts).
//   bun packages/ai/src/build-escorts.ts --servuo <ServUO> [--output packages/ai/locations/escorts.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const escortable = new Set([
  'baseescortable',
  'bridegroom',
  'escortablemage',
  'gargishnoble',
  'merchant',
  'messenger',
  'noble',
  'peasant',
  'seekerofadventure'
]);
const spots = readSpawners(resolve(values.servuo))
  .filter((s) => s.map === 'Trammel' && s.x < 5120 && s.kinds.some((k) => escortable.has(k)))
  .map(({ x, y }) => ({ x, y }))
  .sort((a, b) => a.x - b.x || a.y - b.y);
const output = resolve(values.output ?? new URL('../locations/escorts.json', import.meta.url).pathname);
const source = 'ServUO Spawns/trammel.xml (escortable spawners)';
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, facet: 1, source, spots }, null, 1)}\n`);
console.log(`${spots.length} escort spots written to ${output}`);
