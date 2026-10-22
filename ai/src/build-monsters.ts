import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Offline build of catalogs/monsters.json: the stats of every creature a dungeon room spawns, read
// from the pinned ServUO Scripts/Mobiles constructors (the same numbers uoguide.com publishes).
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, dungeons: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo || !values.dungeons || !values.output)
  throw new Error('--servuo, --dungeons and --output are required');

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.cs')) files.push(path);
  }
};
walk(join(resolve(values.servuo), 'Scripts/Mobiles'));
const classes = new Map<string, string>();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const [, name] of source.matchAll(/public class (\w+)\s*:\s*\w+/g))
    if (name) classes.set(name.toLowerCase(), source);
}

const wanted = new Set<string>();
for (const name of readdirSync(resolve(values.dungeons))) {
  const dungeon = JSON.parse(readFileSync(join(resolve(values.dungeons), name), 'utf8')) as {
    floors: { rooms: { monsters: { type: string }[] }[] }[];
  };
  for (const floor of dungeon.floors)
    for (const room of floor.rooms) for (const m of room.monsters) wanted.add(m.type.toLowerCase());
}

const range = (body: string, call: string) => {
  const match = new RegExp(`${call}\\(\\s*(\\d+)(?:\\s*,\\s*(\\d+))?\\s*\\)`).exec(body);
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : null;
};
const skill = (body: string, name: string) =>
  Number(new RegExp(`SkillName\\.${name},\\s*[\\d.]+,\\s*([\\d.]+)`).exec(body)?.[1] ?? 0);

const monsters = [];
const missing = [];
for (const type of [...wanted].sort()) {
  const source = classes.get(type);
  // The constructor body: from the [Constructable] class constructor to the next member.
  const start = source?.search(new RegExp(`public ${type}\\s*\\(\\s*\\)`, 'i')) ?? -1;
  if (!source || start < 0) {
    missing.push(type);
    continue;
  }
  const body = source.slice(start, start + 4000);
  const className = /public (\w+)\s*\(/.exec(body)?.[1] ?? type;
  const bodies = (/Body\s*=\s*(?:Utility\.RandomList\()?([\dxa-fA-F,\s]+)\)?;/.exec(body)?.[1] ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => v > 0);
  const name = /Name\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null;
  const strength = range(body, 'SetStr');
  const hits = range(body, 'SetHits') ?? strength;
  monsters.push({
    type: className,
    name,
    bodies,
    hits,
    damage: range(body, 'SetDamage'),
    magery: skill(body, 'Magery'),
    resist: skill(body, 'MagicResist'),
    poison: skill(body, 'Poisoning'),
    fame: Number(/Fame\s*=\s*(\d+)/.exec(body)?.[1] ?? 0)
  });
}
if (missing.length) console.error(`No constructor found for: ${missing.join(', ')}`);
writeFileSync(
  resolve(values.output),
  `${JSON.stringify({ schemaVersion: 1, source: 'ServUO Scripts/Mobiles constructors', monsters })}\n`
);
