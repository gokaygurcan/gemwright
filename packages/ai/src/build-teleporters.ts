import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Offline build of locations/teleporters.json from ServUO's Data/teleporters.csv: the overland
// teleporters on Trammel (both ends outside the dungeon map area, x < 5120), such as the ones
// joining the Jhelom islands; a two-way row gives both directions. Residents route through them
// on purpose and never step on one by accident (links.ts).
//   bun packages/ai/src/build-teleporters.ts --servuo <ServUO> [--output packages/ai/locations/teleporters.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
type Point = { x: number; y: number; z: number };
const links: { from: Point; to: Point }[] = [];
for (const line of readFileSync(join(resolve(values.servuo), 'Data/teleporters.csv'), 'utf8').split('\n')) {
  const f = line.trim().split(',');
  if (line.startsWith('#') || f.length < 9 || f[3] !== 'Trammel' || f[7] !== 'Trammel') continue;
  const from = { x: Number(f[0]), y: Number(f[1]), z: Number(f[2]) };
  const to = { x: Number(f[4]), y: Number(f[5]), z: Number(f[6]) };
  if (from.x >= 5120 || to.x >= 5120) continue;
  links.push({ from, to });
  if (f[8] === 'True') links.push({ from: to, to: from });
}
links.sort((a, b) => a.from.x - b.from.x || a.from.y - b.from.y);
const output = resolve(values.output ?? new URL('../locations/teleporters.json', import.meta.url).pathname);
writeFileSync(
  output,
  `{"schemaVersion":1,"source":"ServUO Data/teleporters.csv (overland Trammel teleporters)","links":[\n${links.map((l) => `  ${JSON.stringify(l)}`).join(',\n')}\n]}\n`
);
console.log(`${links.length} teleporter links written to ${output}`);
