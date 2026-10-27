import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Offline build of catalogs/prices.json from ServUO's vendor lists (Scripts/VendorInfo/SB*.cs):
// what an item costs at a shop, by graphic (the lowest price any vendor asks), and what vendors
// pay for it, by type name. Residents value what they own and what they see on others with it
// (self.ts, appraise.ts): a replacement cost, the same on every shard built from that source.
//   bun packages/ai/src/build-prices.ts --servuo <ServUO> [--output packages/ai/catalogs/prices.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo) throw new Error('--servuo is required');
const dir = join(resolve(values.servuo), 'Scripts/VendorInfo');
const buy = new Map<number, { type: string; price: number }>();
const sell = new Map<string, number>();
for (const file of readdirSync(dir).filter((f) => f.endsWith('.cs'))) {
  const source = readFileSync(join(dir, file), 'utf8');
  for (const [, type = '', price = '0', graphic = '0'] of source.matchAll(
    /GenericBuyInfo\(typeof\((\w+)\),\s*(\d+),\s*\d+,\s*(0x[0-9A-Fa-f]+|\d+)/g
  )) {
    const id = Number(graphic);
    const known = buy.get(id);
    if (Number(price) > 0 && (!known || Number(price) < known.price)) buy.set(id, { type, price: Number(price) });
  }
  for (const [, type = '', price = '0'] of source.matchAll(/Add\(typeof\((\w+)\),\s*(\d+)\)/g))
    sell.set(type, Math.max(sell.get(type) ?? 0, Number(price)));
}
const items = [...buy]
  .sort(([a], [b]) => a - b)
  .map(([graphic, { type, price }]) => ({ graphic, type, buy: price, sell: sell.get(type) ?? 0 }));
const output = resolve(values.output ?? new URL('../catalogs/prices.json', import.meta.url).pathname);
writeFileSync(
  output,
  `{"schemaVersion":1,"source":"ServUO Scripts/VendorInfo (GenericBuyInfo and sell lists)","items":[\n${items.map((i) => `  ${JSON.stringify(i)}`).join(',\n')}\n]}\n`
);
console.log(`${items.length} prices written to ${output}`);
