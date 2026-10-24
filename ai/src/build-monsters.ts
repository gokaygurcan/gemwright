import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Offline build of catalogs/monsters.json: the stats of every creature a dungeon room or a Trammel
// spawner (Spawns/trammel.xml) brings out, and of every monster and animal script, read from the
// pinned ServUO Scripts/Mobiles constructors (the same numbers uoguide.com publishes): health,
// damage, combat skills, armor, whether it attacks on sight (FightMode) and its loot packs.
//   bun ai/src/build-monsters.ts --servuo <ServUO> --dungeons ai/catalogs/dungeons --output ai/catalogs/monsters.json
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
const spawns = readFileSync(join(resolve(values.servuo), 'Spawns/trammel.xml'), 'utf8');
for (const [, objects] of spawns.matchAll(/<Objects2>([^<]*)<\/Objects2>/g))
  for (const entry of (objects ?? '').split(':OBJ='))
    wanted.add((entry.split(/[:,/]/)[0] ?? '').replace(/^\{/, '').toLowerCase());
for (const folder of ['Scripts/Mobiles/Monsters', 'Scripts/Mobiles/Animals'])
  for (const file of files.filter((f) => f.includes(join(resolve(values.servuo ?? ''), folder))))
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/public class (\w+)\s*:\s*Base(?:Creature|Mount)/g))
      if (name) wanted.add(name.toLowerCase());
// Rough gold of one ServUO loot pack (LootPack.cs gold entries, averaged).
const packGold: Record<string, number> = {
  Poor: 15,
  Meager: 40,
  Average: 100,
  Rich: 250,
  FilthyRich: 500,
  UltraRich: 900,
  SuperBoss: 1500
};

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
  // FightMode in the base constructor call: Closest, Strongest, Weakest and Evil attack on sight.
  const mode = /FightMode\.(\w+)/.exec(body)?.[1] ?? 'None';
  const loot = [...source.matchAll(/AddLoot\(\s*LootPack\.(\w+)(?:\s*,\s*(\d+))?/g)].reduce(
    (sum, [, pack, times]) => sum + (packGold[pack ?? ''] ?? 0) * Number(times ?? 1),
    0
  );
  monsters.push({
    type: className,
    name,
    bodies,
    hits,
    damage: range(body, 'SetDamage'),
    magery: skill(body, 'Magery'),
    resist: skill(body, 'MagicResist'),
    poison: skill(body, 'Poisoning'),
    fame: Number(/Fame\s*=\s*(\d+)/.exec(body)?.[1] ?? 0),
    aggressive: ['Closest', 'Strongest', 'Weakest', 'Evil'].includes(mode),
    tactics: skill(body, 'Tactics'),
    wrestling: skill(body, 'Wrestling'),
    armor: Number(/VirtualArmor\s*=\s*(\d+)/.exec(body)?.[1] ?? 0),
    gold: loot
  });
}
if (missing.length) console.error(`No constructor found for: ${missing.join(', ')}`);
writeFileSync(
  resolve(values.output),
  `${JSON.stringify({ schemaVersion: 1, source: 'ServUO Scripts/Mobiles constructors', monsters })}\n`
);
