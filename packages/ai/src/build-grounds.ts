import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { monsters } from './dungeons';

// Offline build of catalogs/hunting-grounds.json: the overland places on Trammel where creatures
// that attack on sight spawn (Spawns/trammel.xml spawners, catalogs/monsters.json stats), outside
// towns and dungeons (Data/Regions.xml). Spawners are grouped by 40-tile cell; a cell with at
// least six such creatures is a hunting ground, named after its commonest kinds.
//   bun packages/ai/src/build-grounds.ts --servuo <ServUO> [--output packages/ai/catalogs/hunting-grounds.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const root = resolve(values.servuo);
const regions = readFileSync(join(root, 'Data/Regions.xml'), 'utf8');
const trammel = regions.slice(regions.indexOf('<Facet name="Trammel">'), regions.indexOf('<Facet name="Ilshenar">'));
const blocked: { x: number; y: number; width: number; height: number }[] = [];
for (const [, type, inner] of trammel.matchAll(/<region type="(\w+)"[^>]*>([\s\S]*?)<\/region>/g)) {
  if (!['GuardedRegion', 'TownRegion', 'DungeonRegion', 'NoHousingRegion'].includes(type ?? '')) continue;
  for (const [, attrs] of (inner ?? '').matchAll(/<rect\s+([^>]*)\/>/g)) {
    const attr = (name: string) => Number(new RegExp(`${name}="(-?\\d+)"`).exec(attrs ?? '')?.[1]);
    blocked.push({ x: attr('x'), y: attr('y'), width: attr('width'), height: attr('height') });
  }
}
const inside = (x: number, y: number) =>
  blocked.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

const byType = new Map(monsters.map((m) => [m.type.toLowerCase(), m]));
// Creatures worth hunting: they attack on sight, have known stats and are not human-bodied (a
// brigand looks like a player).
const huntable = (type: string) => {
  const m = byType.get(type);
  return !!m?.aggressive && !!m.hits && !m.bodies.some((b) => b === 0x190 || b === 0x191) && m.fame < 15000;
};

const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
const emptyCell = () => ({ xs: [] as number[], ys: [] as number[], kinds: new Map<string, number>() });
const spawns = readFileSync(join(root, 'Spawns/trammel.xml'), 'utf8');
for (const [, point] of spawns.matchAll(/<Points>([\s\S]*?)<\/Points>/g)) {
  const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(point ?? '')?.[1] ?? '';
  const x = Number(field('CentreX'));
  const y = Number(field('CentreY'));
  if (field('Map') !== 'Trammel' || x >= 5120 || inside(x, y)) continue;
  const kinds = field('Objects2')
    .split(':OBJ=')
    .map((entry) => ({
      type: (entry.split(':')[0] ?? '').toLowerCase(),
      max: Number(/MX=(\d+)/.exec(entry)?.[1] ?? 1)
    }))
    .filter((k) => huntable(k.type));
  if (!kinds.length) continue;
  const key = `${Math.floor(x / 40)},${Math.floor(y / 40)}`;
  const cell = cells.get(key) ?? emptyCell();
  cells.set(key, cell);
  cell.xs.push(x);
  cell.ys.push(y);
  // A spawner with several kinds brings out up to its MaxCount in all; each kind gets its share.
  const total = Number(field('MaxCount')) || kinds.length;
  for (const k of kinds)
    cell.kinds.set(k.type, (cell.kinds.get(k.type) ?? 0) + Math.max(1, Math.round(total / kinds.length)));
}

const label = (type: string) =>
  (byType.get(type)?.name ?? byType.get(type)?.type ?? type).replace(/^(an?|the) /i, '').toLowerCase();
const grounds = [...cells.values()]
  .filter((cell) => [...cell.kinds.values()].reduce((n, v) => n + v, 0) >= 6)
  .map((cell) => {
    const x = Math.round(cell.xs.reduce((n, v) => n + v, 0) / cell.xs.length);
    const y = Math.round(cell.ys.reduce((n, v) => n + v, 0) / cell.ys.length);
    const kinds = [...cell.kinds].sort((a, b) => b[1] - a[1]);
    return {
      name: `${kinds
        .slice(0, 2)
        .map(([type]) => label(type))
        .join(' and ')} spawn near ${x},${y}`,
      center: { x, y },
      radius: 40,
      creatures: Object.fromEntries(kinds.map(([type, n]) => [byType.get(type)?.type ?? type, n]))
    };
  })
  .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
const output = resolve(values.output ?? new URL('../catalogs/hunting-grounds.json', import.meta.url).pathname);
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, grounds }, null, 1)}\n`);
console.log(`Wrote ${grounds.length} hunting grounds to ${output}`);
