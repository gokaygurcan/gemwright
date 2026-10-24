import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { houseFits, lotGrid, type Rect } from './house-fit';
import { Terrain } from './terrain';
import { world } from './world';

// Builds catalogs/house-lots.json from world.json `housing.districts` and the client map files:
// every lot on each district's 9x13 grid where a classic house fits (house-fit.ts), outside the
// server's regions (towns, dungeons and the like, from ServUO's Data/Regions.xml when given).
//   bun src/build-lots.ts --assets <dir> [--regions <Regions.xml>] [--output catalogs/house-lots.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { assets: { type: 'string' }, regions: { type: 'string' }, output: { type: 'string' } }
});
if (!values.assets) throw new Error('--assets is required');
const terrain = Terrain.shared(resolve(values.assets), 1);
const excluded: Rect[] = [];
if (values.regions) {
  const xml = readFileSync(resolve(values.regions), 'utf8');
  const start = xml.indexOf('<Facet name="Trammel">');
  const end = xml.indexOf('</Facet>', start);
  if (start < 0) throw new Error('No Trammel regions in the region file');
  for (const match of xml.slice(start, end).matchAll(/<rect\s+([^>]*)\/>/g)) {
    const attr = (name: string) => Number(new RegExp(`${name}="(-?\\d+)"`).exec(match[1] ?? '')?.[1]);
    excluded.push({ x: attr('x'), y: attr('y'), width: attr('width'), height: attr('height') });
  }
}
const pitch = { x: 9, y: 13 };
const lots: { id: string; district: string; x: number; y: number; z: number }[] = [];
for (const district of world.housing?.districts ?? []) {
  let tried = 0;
  for (const centre of lotGrid(district, pitch)) {
    tried++;
    const z = houseFits(terrain, centre.x, centre.y, excluded);
    if (z !== undefined)
      lots.push({
        id: `${district.name}-${centre.i}-${centre.j}`,
        district: district.name,
        x: centre.x,
        y: centre.y,
        z
      });
  }
  console.log(`${district.name}: ${lots.filter((l) => l.district === district.name).length} of ${tried} lots fit`);
}
const output = resolve(values.output ?? new URL('../catalogs/house-lots.json', import.meta.url).pathname);
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, pitch, lots }, null, 2)}\n`);
console.log(`Wrote ${lots.length} lots to ${output}`);
