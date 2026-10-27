import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { reagentByName } from '@gemwright/common/items';

// Offline build of catalogs/crafts/<skill>.json from the pinned ServUO source: every recipe of the craft
// skills residents use that needs only the skill's basic material (DefBlacksmithy, DefCarpentry,
// DefTailoring, DefTinkering in Scripts/Services/Craft), with its menu group and label, skill
// range, material count and what the vendor who buys that trade's goods pays for it (the union of
// the vendor's SB* sell lists). Recipes with a second material (AddRes), a second skill
// (AddSkill), a learned recipe (AddRecipe) or a text label are left out: a resident stocks one
// material.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo || !values.output) throw new Error('--servuo and --output are required');
const scripts = join(resolve(values.servuo), 'Scripts');

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.cs')) files.push(path);
  }
};
walk(scripts);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const classSource = (name: string) =>
  [...sources.values()].find((text) => new RegExp(`class ${name}\\b`).test(text)) ?? '';

// What a vendor class pays: the InternalSellInfo entries of every SB* list it carries.
function vendorPrices(vendor: string): Map<string, number> {
  const prices = new Map<string, number>();
  for (const [, sb] of classSource(vendor).matchAll(/new (SB\w+)\(/g)) {
    const text = classSource(sb ?? '');
    const sell = text.slice(text.indexOf('InternalSellInfo'));
    for (const [, type, price] of sell.matchAll(/Add\(\s*typeof\((\w+)\)\s*,\s*(\d+)\s*\)/g))
      if (type && !prices.has(type)) prices.set(type, Number(price));
  }
  return prices;
}

const words = (type: string) =>
  type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

// Reagents an alchemy recipe may use as its material (item graphics), and the bottle every potion
// also takes (DefAlchemy AddRes Bottle).
const BOTTLE = 0x0f0e;

function recipes(def: string, material: string, prices: Map<string, number>) {
  const text = sources.get(join(scripts, 'Services/Craft', `${def}.cs`)) ?? '';
  const calls = [
    ...text.matchAll(
      /AddCraft\(typeof\((\w+)\),\s*(\d+),\s*(\d+),\s*([\d.-]+),\s*([\d.-]+),\s*typeof\((\w+)\),\s*[\d"\w ]+,\s*(\d+)/g
    )
  ];
  const seen = new Set<string>();
  return calls.flatMap((call, i) => {
    const [, type, group, label, min, max, resource, amount] = call;
    const after = text.slice((call.index ?? 0) + call[0].length, calls[i + 1]?.index ?? text.length);
    // Only follow-up calls on this recipe's own index (before the next AddCraft) count.
    const own = after.split(/\n\s*\n/)[0] ?? after;
    // Potions add exactly one bottle; any other second material, skill or learned recipe is out.
    const bottle = material === 'Reagent' && /AddRes\(index, typeof\(Bottle\), \d+, 1,/.test(own);
    const extra =
      /\b(AddSkill|AddRecipe|AddRequiredSkill)\(/.test(own) || (own.match(/AddRes\(/g)?.length ?? 0) > (bottle ? 1 : 0);
    const matches = material === 'Reagent' ? !!reagentByName[resource ?? ''] && bottle : resource === material;
    if (!type || !matches || extra || seen.has(type)) return [];
    seen.add(type);
    return [
      {
        name: words(type),
        group: Number(group),
        label: Number(label),
        min: Number(min),
        max: Number(max),
        amount: Number(amount),
        pays: prices.get(type) ?? 0,
        ...(material === 'Reagent'
          ? { material: reagentByName[resource ?? ''], extra: [{ graphic: BOTTLE, amount: 1 }] }
          : {})
      }
    ];
  });
}

const crafts = {
  Blacksmith: {
    def: 'DefBlacksmithy',
    material: 'IronIngot',
    graphic: 0x1bf2,
    vendor: 'Blacksmith',
    service: 'blacksmith'
  },
  Carpentry: { def: 'DefCarpentry', material: 'Board', graphic: 0x1bd7, vendor: 'Carpenter', service: 'carpenter' },
  Tailoring: { def: 'DefTailoring', material: 'Cloth', graphic: 0x1766, vendor: 'Tailor', service: 'tailor' },
  Tinkering: { def: 'DefTinkering', material: 'IronIngot', graphic: 0x1bf2, vendor: 'Tinker', service: 'tinker' },
  // Each potion names its own reagent (`material` per recipe) and a bottle.
  Alchemy: { def: 'DefAlchemy', material: 'Reagent', graphic: 0x0f85, vendor: 'Alchemist', service: 'alchemist' },
  Bowcraft: { def: 'DefBowFletching', material: 'Board', graphic: 0x1bd7, vendor: 'Bowyer', service: 'bowyer' }
};
// One file per skill keeps each catalog small enough to read and review.
mkdirSync(resolve(values.output), { recursive: true });
for (const [skill, c] of Object.entries(crafts)) {
  // Gargoyle-only gear is left out (gargoyles are not created by default), and so is any recipe
  // whose menu label another recipe shares: its button could not be told apart.
  const all = recipes(c.def, c.material, vendorPrices(c.vendor)).filter((r) => !r.name.includes('gargish'));
  const list = all
    .filter((r) => all.filter((other) => other.label === r.label).length === 1)
    .sort((a, b) => a.min - b.min || a.label - b.label);
  console.error(
    `${skill}: ${list.length} recipes, ${list.filter((r) => r.pays > 0).length} bought by the ${c.service}`
  );
  const body = {
    schemaVersion: 1,
    source: `ServUO ${c.def}.cs and the ${c.vendor}'s SB* sell lists`,
    skill,
    material: c.material,
    graphic: c.graphic,
    vendor: c.service
  };
  // One recipe per line.
  const lines = list.map((r) => `  ${JSON.stringify(r)}`).join(',\n');
  writeFileSync(
    join(resolve(values.output), `${skill.toLowerCase()}.json`),
    `${JSON.stringify(body).slice(0, -1)},"recipes":[\n${lines}\n]}\n`
  );
}
