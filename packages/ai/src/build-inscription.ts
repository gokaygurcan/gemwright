import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { reagentByName } from '@gemwright/common/items';

// Offline build of catalogs/crafts/inscription.json from the pinned ServUO source
// (Scripts/Services/Craft/DefInscription.cs): the Magery spell scrolls (AddSpell: a circle's skill
// range and menu group, the label 1044381 + its place in the list, its reagents and a blank
// scroll) and the runebook (eight blank scrolls, a Recall and a Gate Travel scroll). A scroll needs
// its spell in the scribe's spellbook (DefInscription.CanCraft), which recipe users check.
//   bun packages/ai/src/build-inscription.ts --servuo <ServUO> [--output packages/ai/catalogs/crafts/inscription.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const source = readFileSync(join(resolve(values.servuo), 'Scripts/Services/Craft/DefInscription.cs'), 'utf8');
const reagent = reagentByName;
const BLANK = 0x0e34;
// Spell ids by name (catalogs/magery-spells.json): the menu's order is not the spell order.
const spellIds = new Map(
  (
    JSON.parse(readFileSync(new URL('../catalogs/magery-spells.json', import.meta.url), 'utf8')) as {
      spells: { name: string; id: number }[];
    }
  ).spells.map((s) => [s.name.toLowerCase().replace(/\W/g, ''), s.id])
);
// AddSpell's ranges and menu groups by circle index (m_Circle 0-7).
const ranges = [
  [-25, 25, 1111691],
  [-10.8, 39.2, 1111691],
  [3.5, 53.5, 1111692],
  [17.8, 67.8, 1111692],
  [32.1, 82.1, 1111693],
  [46.4, 96.4, 1111693],
  [60.7, 110.7, 1111694],
  [75, 125, 1111694]
] as const;
// The scroll graphic for spell id n (Loot.RegularScrollTypes order; SBMage's mapping).
const scrollGraphic = (id: number) => (id === 7 ? 0x1f2d : id < 7 ? 0x1f2d + id : 0x1f2c + id);

const recipes: object[] = [];
let circle = 0;
let index = 0;
const body = source.slice(source.indexOf('m_Circle = 0;'));
for (const line of body.split('\n')) {
  const set = /m_Circle = (\d);/.exec(line);
  if (set) circle = Number(set[1]);
  const spell = /AddSpell\(typeof\((\w+)Scroll\), ([^)]+)\)/.exec(line);
  if (!spell?.[1] || !spell[2]) continue;
  const regs = spell[2].split(',').map((r) => reagent[r.trim().replace('Reg.', '')] ?? 0);
  const [min, max, group] = ranges[circle] ?? ranges[0];
  const id = spellIds.get(spell[1].toLowerCase()) ?? index + 1;
  recipes.push({
    name: `${spell[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} scroll`,
    spell: id,
    graphic: scrollGraphic(id),
    group,
    label: 1044381 + index++,
    min,
    max,
    amount: 1,
    pays: 0,
    material: regs[0],
    extra: [...regs.slice(1).map((graphic) => ({ graphic, amount: 1 })), { graphic: BLANK, amount: 1 }]
  });
  if (index >= 64) break;
}
const book = /AddCraft\(typeof\(Runebook\), (\d+), (\d+), ([\d.]+), ([\d.]+)/.exec(source);
if (!book) throw new Error('No runebook recipe in DefInscription.cs');
recipes.push({
  name: 'runebook',
  graphic: 0x22c5,
  group: Number(book[1]),
  label: Number(book[2]),
  min: Number(book[3]),
  max: Number(book[4]),
  amount: 8,
  pays: 0,
  material: BLANK,
  extra: [
    { graphic: scrollGraphic(32), amount: 1 },
    { graphic: scrollGraphic(52), amount: 1 }
  ]
});
const output = resolve(values.output ?? 'packages/ai/catalogs/crafts/inscription.json');
writeFileSync(
  output,
  `{"schemaVersion":1,"source":"ServUO DefInscription.cs","skill":"Inscription","material":"BlankScroll","graphic":${BLANK},"vendor":"mage","recipes":[\n${recipes.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]}\n`
);
console.log(`${recipes.length} inscription recipes written to ${output}`);
