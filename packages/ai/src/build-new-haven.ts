import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readSpawners, regionRects, shares } from './spawns';

// Offline build of locations/new-haven.json from the ServUO source: what a new resident of New
// Haven needs to know. The island and town bounds, mines and docks (Data/Regions.xml), the public
// moongate (PublicMoongate.cs), every vendor by the service it gives and the monster grounds
// outside town by kind, for fighters (Spawns/trammel.xml).
//   bun packages/ai/src/build-new-haven.ts --servuo <ServUO> [--output packages/ai/locations/new-haven.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const root = resolve(values.servuo);
const region = (name: string) => {
  const rect = regionRects(root, name)[0];
  if (!rect) throw new Error(`Regions.xml has no ${name} on Trammel`);
  return rect;
};
const island = region('Haven Island');
const town = region('New Haven');
const mountains = region('Haven Mountains');
const quay = region('the New Haven Docks');
const inside = (r: typeof island, p: { x: number; y: number }) =>
  p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
const gateLine = /new PMEntry\(new Point3D\((\d+), (\d+), (-?\d+)\), \d+\) \/\/ New Haven/.exec(
  readFileSync(join(root, 'Scripts/Items/Functional/PublicMoongate.cs'), 'utf8')
);
if (!gateLine) throw new Error('PublicMoongate.cs has no New Haven entry');
const moongate = { x: Number(gateLine[1]), y: Number(gateLine[2]), z: Number(gateLine[3]) };
// NPC type (lower-cased) -> the services it gives (locations.ts ServiceType).
const services: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    Banker: ['banker'],
    Healer: ['healer'],
    HealerGuildmaster: ['healer'],
    Blacksmith: ['blacksmith'],
    BlacksmithGuildmaster: ['blacksmith'],
    IronWorker: ['blacksmith'],
    Armorer: ['blacksmith'],
    Weaponsmith: ['weaponsmith'],
    Mage: ['mage'],
    MageGuildmaster: ['mage'],
    HolyMage: ['mage'],
    Scribe: ['mage'],
    Tailor: ['tailor'],
    Weaver: ['tailor'],
    TailorGuildmaster: ['tailor'],
    Carpenter: ['carpenter'],
    Alchemist: ['alchemist'],
    Herbalist: ['alchemist'],
    Tinker: ['tinker', 'mining-tools'],
    TinkerGuildmaster: ['tinker', 'mining-tools'],
    Miner: ['mining-tools'],
    Provisioner: ['provisioner'],
    AnimalTrainer: ['animal-trainer'],
    Fisherman: ['fisherman'],
    FisherGuildmaster: ['fisherman'],
    Jeweler: ['jeweler'],
    Cook: ['cook'],
    Baker: ['cook'],
    Bard: ['bard']
  }).map(([type, s]) => [type.toLowerCase(), s])
);
const { monsters } = JSON.parse(readFileSync(new URL('../catalogs/monsters.json', import.meta.url), 'utf8')) as {
  monsters: { type: string; aggressive?: boolean }[];
};
const hostile = new Set(monsters.filter((m) => m.aggressive).map((m) => m.type.toLowerCase()));
const label = (type: string) => type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const named = new Map(monsters.map((m) => [m.type.toLowerCase(), m.type]));
const found: Record<string, { name: string; x: number; y: number }[]> = {};
const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
for (const spawner of readSpawners(root)) {
  const { x, y } = spawner;
  if (spawner.map !== 'Trammel' || !inside(island, spawner)) continue;
  for (const type of spawner.kinds)
    for (const service of services[type] ?? []) {
      found[service] ??= [];
      found[service].push({ name: `New Haven ${type}`, x, y });
    }
  const kinds = shares(spawner).filter((k) => hostile.has(k.type));
  if (!kinds.length || inside(town, spawner)) continue;
  const key = `${Math.floor(x / 30)},${Math.floor(y / 30)}`;
  const cell = cells.get(key) ?? { xs: [], ys: [], kinds: new Map<string, number>() };
  cells.set(key, cell);
  cell.xs.push(x);
  cell.ys.push(y);
  for (const k of kinds) {
    const type = named.get(k.type) ?? k.type;
    cell.kinds.set(type, (cell.kinds.get(type) ?? 0) + k.count);
  }
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const grounds = [...cells.values()]
  .filter((c) => [...c.kinds.values()].reduce((n, v) => n + v, 0) >= 4)
  .map((c) => {
    const kinds = [...c.kinds].sort((a, b) => b[1] - a[1]);
    return {
      name: `${kinds
        .slice(0, 2)
        .map(([k]) => label(k))
        .join(' and ')} near ${median(c.xs)},${median(c.ys)}`,
      center: { x: median(c.xs), y: median(c.ys) },
      radius: 30,
      creatures: Object.fromEntries(kinds)
    };
  })
  .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
const centre = (r: typeof island) => ({ x: Math.round((r.x0 + r.x1) / 2), y: Math.round((r.y0 + r.y1) / 2) });
const output = resolve(values.output ?? new URL('../locations/new-haven.json', import.meta.url).pathname);
writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: 'ServUO Data/Regions.xml, Spawns/trammel.xml and PublicMoongate.cs (Haven Island)',
      island,
      town,
      moongate,
      mines: {
        ...centre(mountains),
        radius: Math.round(Math.max(mountains.x1 - mountains.x0, mountains.y1 - mountains.y0) / 2)
      },
      docks: centre(quay),
      // The undead of Old Haven serve as the graveyard (bards, fighters starting out).
      services: { ...found, graveyard: [{ name: 'Old Haven', x: 3650, y: 2510 }] },
      grounds
    },
    null,
    1
  )}\n`
);
console.log(
  `New Haven: ${Object.keys(found).length} services, ${grounds.length} grounds, moongate ${JSON.stringify(moongate)}`
);
