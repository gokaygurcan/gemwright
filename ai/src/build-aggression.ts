import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Offline build of catalogs/aggressive-bodies.json: the bodies of creatures that attack on sight,
// read from the pinned ServUO Scripts/Mobiles constructors. FightMode.Closest, Strongest, Weakest
// and Evil seek out targets; Aggressor (fights back) and None do not. A body any aggressive creature
// wears counts as aggressive. Human bodies are left out: vendors and townsfolk wear them too, and a
// hostile human shows as a criminal or murderer instead.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo || !values.output) throw new Error('--servuo and --output are required');

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.cs')) files.push(path);
  }
};
walk(join(resolve(values.servuo), 'Scripts/Mobiles'));

const humans = new Set([0x190, 0x191, 0x25d, 0x25e, 0x29a, 0x29b]);
// Per body: the names of the aggressive creatures wearing it, and whether a passive one does too.
const seen = new Map<number, { aggressive: Set<string>; passive: boolean }>();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  // Each constructor that calls base(AIType.X, FightMode.Y, ...): its body runs to the next member.
  for (const match of source.matchAll(/:\s*base\s*\(\s*AIType\.\w+\s*,\s*FightMode\.(\w+)/g)) {
    const attacks = ['Closest', 'Strongest', 'Weakest', 'Evil'].includes(match[1] ?? '');
    const rest = source.slice((match.index ?? 0) + match[0].length);
    const end = rest.search(/\n\s*(?:public|protected|private|\[)/);
    const ctor = rest.slice(0, end < 0 ? 3000 : end);
    const name = /Name\s*=\s*"([^"]+)"/.exec(ctor)?.[1]?.toLowerCase() ?? '';
    const list = /Body(?:Value)?\s*=\s*(?:Utility\.RandomList\()?([\dxa-fA-F,\s]+)\)?;/.exec(ctor)?.[1];
    for (const value of (list ?? '').split(',')) {
      const body = Number(value.trim());
      if (!Number.isInteger(body) || body <= 0 || humans.has(body)) continue;
      const entry = seen.get(body) ?? { aggressive: new Set<string>(), passive: false };
      if (attacks) entry.aggressive.add(name);
      else entry.passive = true;
      seen.set(body, entry);
    }
  }
}
// Bodies only aggressive creatures wear are threats on sight. A body passive creatures share is a
// threat under an aggressive creature's name; unnamed, it is a threat (`hostile`) unless it is one of
// the animals met everywhere in and around towns, far commoner than their aggressive look-alikes.
const common = new Set([0xc9, 0xd9, 0xee]); // cat (not a hell cat), dog, rat (not a sewer rat)
const bodies = [...seen]
  .filter(([, e]) => e.aggressive.size && !e.passive)
  .map(([body]) => body)
  .sort((a, b) => a - b);
const shared = Object.fromEntries(
  [...seen]
    .filter(([, e]) => e.aggressive.size && e.passive)
    .sort(([a], [b]) => a - b)
    .map(([body, e]) => [body, { names: [...e.aggressive].filter(Boolean).sort(), hostile: !common.has(body) }])
);
writeFileSync(
  resolve(values.output),
  `${JSON.stringify({ schemaVersion: 1, source: 'ServUO Scripts/Mobiles FightMode', bodies, shared })}\n`
);
console.log(`Wrote ${bodies.length} aggressive bodies and ${Object.keys(shared).length} shared ones`);
