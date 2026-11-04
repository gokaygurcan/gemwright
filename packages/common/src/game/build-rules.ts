import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type CreatureFacts, creatureFacts } from './rules-creatures';
import { bodyAt, hex, uncommented } from './rules-source';
import { ruleTables } from './rules-tables';

// Offline build of rules.json (the Rules layer) from the pinned ServUO's sources: every class with
// its base and the facts the residents act on (graphics it shows, harvest system it works, weapon
// skill, gargoyle-only use, hue, bodies, vendor lists it carries), each vendor list's buy and sell
// entries, the reagents each school of magic uses, the races and their looks, the skills and the maps,
// harvest tiles and ores, doors, spell scrolls and mana, crafting stations and the moongates; and
// creatures.json, every creature's facts (rules-creatures.ts).
//   bun packages/common/src/game/build-rules.ts --servuo <ServUO>
const { values } = parseArgs({ args: process.argv.slice(2), options: { servuo: { type: 'string' } } });
if (!values.servuo) throw new Error('--servuo is required');
const root = resolve(values.servuo);
const read = (folder: string) =>
  readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.cs'))
    .map((name) => ({ name, text: uncommented(readFileSync(join(root, folder, name), 'utf8')) }));
const scripts = read('Scripts');
const engine = read('Server');
const sources = [
  ...engine.map((file) => ({ ...file, engine: true })),
  ...scripts.map((file) => ({ ...file, engine: false }))
];
type ClassFacts = {
  b: string;
  rw?: [string, number, number];
  c?: string;
  i?: string[];
  g?: number[];
  h?: string;
  own?: 1;
  s?: string;
  r?: 1;
  hue?: number;
  bodies?: number[];
  sb?: string[];
};
const classes: Record<string, ClassFacts> = {};
const doorArgs = new Map<string, RegExpMatchArray[]>();
const scrollArgs = new Map<string, [number, number]>();
const creatureBodies = new Map<string, string>();
const sb: Record<string, { sells: [string, number, number][]; buys: [string, number][] }> = {};
for (const { text, engine: core } of sources) {
  for (const match of text.matchAll(/class\s+(\w+)\s*:\s*(\w+)((?:\s*,\s*[\w.]+)*)/g)) {
    const name = match[1] ?? '';
    const body = bodyAt(text, match.index);
    if ((match[2] ?? '') === 'SBInfo') {
      sb[name] = {
        sells: [
          ...body.matchAll(
            /(?:Generic|Animal)BuyInfo\(\s*(?:"[^"]*"\s*,\s*|\d+\s*,\s*)?typeof\((\w+)\),\s*(\d+),\s*\d+,\s*(0x[0-9A-Fa-f]+|\d+)/g
          )
        ].map(([, type = '', price = '0', graphic = '0']) => [type, Number(price), Number(graphic)]),
        buys: [...body.matchAll(/Add\(typeof\((\w+)\),\s*(\d+)\)/g)].map(([, type = '', price = '0']) => [
          type,
          Number(price)
        ])
      };
      continue;
    }
    const before = text.slice(Math.max(0, match.index - 300), match.index);
    const facts: ClassFacts = { b: match[2] ?? '' };
    const interfaces = [...(match[3] ?? '').matchAll(/(?:\w+\.)*(I[A-Z]\w*)/g)].map((m) => m[1] ?? '');
    if (interfaces.length) facts.i = interfaces;
    // The attribute right above the class ([Flipable(0xE86, 0xE85)]), the first graphic its
    // constructors pass on (base(0xE86), base(uses, 0xF39)) and every graphic it switches to (ItemID = 0x19B8).
    const flip = [...before.matchAll(/\[Flip\w*\(([^)]*)\)\]/gi)].at(-1)?.[1] ?? '';
    // A graphic parameter's default (Runebook(int maxCharges, int id = 0x22C5)) stands in for its name.
    const defaults = [...body.matchAll(/\bint\s+(\w+)\s*=\s*(0x[0-9a-f]+)/gi)];
    const ctors = [...body.matchAll(/:\s*(?:base|this)\(([^)]*\)?)\)/g)].map((m) =>
      defaults.reduce(
        (args, [, name, value]) => args.replace(new RegExp(`\\b${name}\\b`, 'g'), value ?? ''),
        m[1] ?? ''
      )
    );
    // A graphic passed on: the first hex argument, a lone number (base(17606)), or a random range
    // (base(Utility.Random(0x09CC, 4)): four graphics from 0x09CC).
    const range = ctors
      .map((args) => /Utility\.Random\(\s*(0x[0-9a-f]+|\d+)\s*,\s*(\d+)\s*\)/i.exec(args))
      .find(Boolean);
    const ctor =
      ctors.find((args) => !/Utility\.Random/.test(args) && /0x[0-9a-f]+/i.test(args)) ??
      ctors.find((args) => /^\s*\d+\s*$/.test(args) && Number(args) > 1) ??
      '';
    const passed = range
      ? Array.from({ length: Number(range[2]) }, (_, i) => Number(range[1]) + i)
      : /0x[0-9a-f]+/i.test(ctor)
        ? // A choice between graphics (base(bloodied ? 0x1D98 : 0x3)) passes on either.
          hex(/^[^,]*\?[^,]*:[^,]*/.exec(ctor)?.[0] ?? '').concat(hex(ctor).slice(0, 1))
        : ctor
          ? [Number(ctor)]
          : [];
    // A constructor that takes its graphic from a method of the class (BaseOre: base(RandomSize())).
    const picker = /:\s*base\(\s*(\w+)\(\)\s*\)/.exec(body)?.[1];
    const picked = picker
      ? hex(new RegExp(`\\b${picker}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(body)?.[1] ?? '')
      : [];
    const graphics = [
      ...new Set([
        ...hex(flip),
        ...passed,
        ...picked,
        ...[...body.matchAll(/ItemID\s*=\s*(0x[0-9a-f]+)/gi)].map((m) => Number(m[1])),
        // An addon's own pieces (AddComponent(new AddonComponent(0x1015), ...)).
        ...[...body.matchAll(/new\s+\w*AddonComponent\(\s*(0x[0-9a-f]+)/gi)].map((m) => Number(m[1])),
        // and the graphics it switches them between (a spinning wheel's turning frames).
        ...(/AddonComponent\(/.test(body)
          ? [...body.matchAll(/case\s+(0x[0-9a-f]+)\s*:/gi)].map((m) => Number(m[1]))
          : [])
      ])
    ];
    // The engine's own classes (Item, Mobile) pass no graphic of their own on to a script's items.
    if (graphics.length && !core) facts.g = graphics;
    const harvest =
      /HarvestSystem\s+HarvestSystem[\s\S]{0,120}?return\s+(\w+)\.System/.exec(body)?.[1] ??
      /(\w+)\.System\.BeginHarvesting/.exec(body)?.[1];
    if (harvest) facts.h = harvest.toLowerCase();
    if (/override\s+void\s+OnDoubleClick\s*\(/.test(body)) facts.own = 1;
    // A tool's craft system (CraftSystem { get { return DefAlchemy.CraftSystem; } }).
    const craft = /CraftSystem\s+CraftSystem[\s\S]{0,80}?return\s+(Def\w+)\.CraftSystem/.exec(body)?.[1];
    if (craft) facts.c = craft;
    // A ranged weapon's ammunition, reach and seconds per shot (AmmoType, DefMaxRange, MlSpeed).
    const getter = (property: string) =>
      new RegExp(`override\\s+[\\w.]+\\s+${property}\\b[\\s\\S]{0,60}?return\\s+([^;]+);`).exec(body)?.[1]?.trim();
    const ammo = /typeof\((\w+)\)/.exec(getter('AmmoType') ?? '')?.[1];
    const reach = Number(getter('DefMaxRange'));
    const speed = Number.parseFloat(getter('MlSpeed') ?? '');
    if (ammo && reach && speed) facts.rw = [ammo, reach, speed];
    const skill = /SkillName\s+DefSkill[\s\S]{0,80}?SkillName\.(\w+)/.exec(body)?.[1];
    if (skill) facts.s = skill;
    if (/Race\s+RequiredRace[\s\S]{0,80}?Race\.Gargoyle/.test(body)) facts.r = 1;
    const hue = /\n\s*Hue\s*=\s*(\d+)\s*;/.exec(body)?.[1];
    if (hue) facts.hue = Number(hue);
    // Its body: set outright, from a random list, or from an array (Horse: `Body = m_IDs[random * 2]`,
    // every other entry), else a mount's constructor (`base(name, 0xE2, 0x3EA0, ...)`: body, then item).
    const direct = /\bBody(?:Value)?\s*=\s*(?:Utility\.RandomList\(([^)]*)\)|(0x[0-9a-f]+|\d+))\s*;/i.exec(body);
    const indexed = /\bBody\s*=\s*(\w+)\[[^\]]*?(\*\s*2)?\]/.exec(body);
    const array = indexed
      ? new RegExp(`${indexed[1]}\\s*=\\s*new\\s+int\\[\\]\\s*\\{([^}]*)\\}`).exec(body)?.[1]
      : undefined;
    const mount = /:\s*base\(\s*(?:name|"[^"]*")\s*,\s*(0x[0-9a-f]+|\d+)\s*,\s*(0x[0-9a-f]+|\d+)/i.exec(body);
    const bodies = direct
      ? (direct[1] ?? direct[2] ?? '').split(',').map((v) => Number(v.trim()))
      : array
        ? [...array.matchAll(/0x[0-9a-f]+|\d+/gi)]
            .map((m) => Number(m[0]))
            .filter((_, i) => !indexed?.[2] || i % 2 === 0)
        : mount
          ? [Number(mount[1])]
          : [];
    if (bodies.some((v) => v > 0)) facts.bodies = [...new Set(bodies.filter((v) => v > 0))];
    const lists = [...body.matchAll(/SBInfos\.Add\(new\s+(SB\w+)/g)].map((m) => m[1] ?? '');
    if (lists.length) facts.sb = lists;
    classes[name] = facts;
    if (!core && /AIType\.|SetStr|SetHits|\bName\s*=|\bBody\s*=/.test(body)) creatureBodies.set(name, body);
    const doors = [
      ...body.matchAll(
        /:\s*base\(\s*(?:facing\s*,\s*)?(0x[0-9a-f]+)\s*(\+\s*\(2\s*\*\s*\(int\)facing\))?\s*,\s*(0x[0-9a-f]+)/gi
      )
    ];
    if (doors.length) doorArgs.set(name, doors);
    const scroll = /:\s*base\(\s*(\d+)\s*,\s*(0x[0-9a-f]+)\s*,\s*amount\s*\)/i.exec(body);
    if (scroll) scrollArgs.set(name, [Number(scroll[1]), Number(scroll[2])]);
  }
}
// Doors as closed and open graphics: each door class's constructor (one for each of the eight facings
// when it adds `2 * (int)facing`), and the house designer's doors (Data/Components/doors.txt, one
// closed graphic per facing, opened at the next).
const descends = (name: string, base: string): boolean =>
  name === base || (!!classes[name] && classes[name].b !== name && descends(classes[name].b, base));
const doorPairs = new Map<number, number>();
for (const [name, matches] of doorArgs)
  if (descends(name, 'BaseDoor') || descends(name, 'BaseSliding'))
    for (const [, closed, perFacing, open] of matches)
      for (let facing = 0; facing < (perFacing ? 8 : 1); facing++)
        doorPairs.set(Number(closed) + 2 * facing, Number(open) + 2 * facing);
for (const line of readFileSync(join(root, 'Data/Components/doors.txt'), 'utf8').split('\n').slice(3))
  for (const piece of line.split('\t').slice(1, 9).map(Number)) if (piece > 0) doorPairs.set(piece, piece + 1);
const doors = [...doorPairs].sort((a, b) => a[0] - b[0]);
// Mana a Magery spell costs by circle (MagerySpell.cs m_ManaTable, first circle first).
const magerySpell = scripts.find(({ name }) => name.endsWith('Spells/Base/MagerySpell.cs'))?.text ?? '';
const manaByCircle = [
  ...(/m_ManaTable\s*=\s*new\s+int\[\]\s*\{([^}]*)\}/.exec(magerySpell)?.[1] ?? '').matchAll(/\d+/g)
].map((m) => Number(m[0]));
// Each spell's scroll (SpellScroll classes, `base(spellID, itemID, amount)`), by ServUO's 0-based spell id.
const spellScrolls: Record<number, number> = {};
for (const [name, [spell, graphic]] of scrollArgs) if (descends(name, 'SpellScroll')) spellScrolls[spell] = graphic;
// The reagents each school's spells use (`Reagent.X` in their spell scripts).
const used = (folders: string[]) =>
  [
    ...new Set(
      scripts
        .filter(({ name }) => folders.some((f) => name.startsWith(`Spells/${f}/`)))
        .flatMap(({ text }) => [...text.matchAll(/Reagent\.(\w+)/g)].map((m) => m[1] ?? ''))
    )
  ].sort();
const reagents = {
  magery: used(['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']),
  necromancy: used(['Necromancy'])
};
const skillSource = uncommented(readFileSync(join(root, 'Server/Skills.cs'), 'utf8'));
const skillEnum = /enum SkillName\s*\{([\s\S]*?)\}/.exec(skillSource)?.[1] ?? '';
const labels = new Map(
  [...skillSource.matchAll(/new SkillInfo\((\d+),\s*"([^"]+)"/g)].map((m) => [Number(m[1]), m[2] ?? ''])
);
// Each skill's enum name (SkillName) and the name players read (SkillInfo), by id.
const skills = [...skillEnum.matchAll(/(\w+)\s*=\s*(\d+)/g)]
  .sort((a, b) => Number(a[2]) - Number(b[2]))
  .map((m) => ({ name: m[1] ?? '', label: labels.get(Number(m[2])) ?? m[1] ?? '' }));
// The ore pile ServUO smelts only two or more of (Ore.cs: `ItemID == 0x19B7 && ... Amount < 2`).
const smallOre = Number(
  /ItemID\s*==\s*(0x[0-9a-f]+)\s*&&[^\n]*Amount\s*<\s*2/i.exec(
    scripts.find(({ name }) => name.endsWith('Items/Resource/Ore.cs'))?.text ?? ''
  )?.[1] ?? 0
);
const mapSource = uncommented(readFileSync(join(root, 'Scripts/Misc/MapDefinitions.cs'), 'utf8'));
const maps: Record<number, { name: string; width: number; height: number }> = {};
for (const [, id = '', width = '', height = '', name = ''] of mapSource.matchAll(
  /RegisterMap\(\s*(0x[0-9a-f]+|\d+)\s*,[^,]+,[^,]+,\s*([^,]+?)\s*,\s*([^,]+?)\s*,[^,]+,\s*"(\w+)"/gi
))
  maps[Number(id)] ??= { name, width: Number(width) || 0, height: Number(height) || 0 };
// Fishable water (Fishing.cs m_WaterTiles: pairs of first and last tile; land below 0x4000, statics
// above it, offset by 0x4000), the tiles a fishing pole may be cast at.
const fishing = scripts.find(({ name }) => name.endsWith('Services/Harvest/Fishing.cs'))?.text ?? '';
const waterRanges = hex(/m_WaterTiles\s*=\s*new\s+int\[\]\s*\{([^}]*)\}/.exec(fishing)?.[1] ?? '');
const water = { land: [] as number[], statics: [] as number[] };
for (let i = 0; i + 1 < waterRanges.length; i += 2)
  for (let id = waterRanges[i] ?? 0; id <= (waterRanges[i + 1] ?? -1); id++)
    if (id < 0x4000) water.land.push(id);
    else water.statics.push(id - 0x4000);
// A harvest system's tile list (`m_Name = new int[] { ... }`, decimal or hex), split into land tiles and
// statics (above 0x4000, offset by it) as tiles a tool may be used on.
const harvestText = (file: string) => scripts.find(({ name }) => name.endsWith(`Services/Harvest/${file}`))?.text ?? '';
const tilesOf = (text: string, list: string) => {
  const ids = [
    ...(new RegExp(`${list}\\s*=\\s*new\\s+int\\[\\]\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? '').matchAll(
      /0x[0-9a-f]+|\d+/gi
    )
  ].map((m) => Number(m[0]));
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  return {
    land: unique.filter((id) => id < 0x4000),
    statics: unique.filter((id) => id >= 0x4000).map((id) => id - 0x4000)
  };
};
const mining = harvestText('Mining.cs');
// The ores Mining.cs yields from mountain and cave tiles, the skill each needs, and its hue (ResourceInfo.cs).
const resourceText = scripts.find(({ name }) => name.endsWith('Misc/ResourceInfo.cs'))?.text ?? '';
const oreHues = new Map(
  [
    ...resourceText.matchAll(/new CraftResourceInfo\((0x[0-9a-f]+)[^;]*?typeof\(\w+Ingot\),\s*typeof\((\w+Ore)\)/gi)
  ].map((m) => [m[2] ?? '', Number(m[1])])
);
const harvest = {
  trees: tilesOf(harvestText('Lumberjacking.cs'), 'm_TreeTiles'),
  rock: tilesOf(mining, 'm_MountainAndCaveTiles'),
  ores: [...mining.matchAll(/new HarvestResource\(([\d.]+),[^;]*?typeof\((\w+Ore)\)/g)].map((m) => ({
    type: m[2] ?? '',
    skill: Number(m[1]),
    hue: oreHues.get(m[2] ?? '') ?? 0
  }))
};
// Trammel's public moongates (PublicMoongate.cs PMList.Trammel): where each stands and the label of its
// destination in the gate menu, keyed by ServUO's own name for it (the entry's comment, `Skara Brae`).
// A height ServUO works out from the map at run time is left at 0.
const gateFile = readdirSync(join(root, 'Scripts'), { recursive: true, encoding: 'utf8' }).find((name) =>
  name.endsWith('PublicMoongate.cs')
);
const gateText = gateFile ? readFileSync(join(root, 'Scripts', gateFile), 'utf8') : '';
const trammelGates = /PMList\s+Trammel\s*=\s*new\s+PMList\(([\s\S]*?)\}\s*\)\s*;/.exec(gateText)?.[1] ?? '';
const gates: Record<string, { x: number; y: number; z: number; label: number }> = {};
for (const [, x, y, z, label, name] of trammelGates.matchAll(
  /new PMEntry\(new Point3D\((\d+),\s*(\d+),\s*([^)]+?\)?)\),\s*(\d+)\)[^\n]*?\/\/\s*([^\n]+)/g
))
  gates[
    (name ?? '')
      .replace(/\(new\)/i, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '')
  ] = {
    x: Number(x),
    y: Number(y),
    z: Number(z) || 0,
    label: Number(label)
  };
const { stations, world, races } = ruleTables(root, scripts, classes);
// Every creature's facts (rules-creatures.ts), by class, bases before their kinds.
const creatureFactsOf = new Map<string, CreatureFacts | undefined>();
const factsOf = (name: string): CreatureFacts | undefined => {
  if (creatureFactsOf.has(name)) return creatureFactsOf.get(name);
  creatureFactsOf.set(name, undefined);
  const base = classes[name]?.b;
  // BaseCreature's own body holds every creature's shared code, no one creature's facts.
  if (name === 'BaseCreature') return undefined;
  const inherited = base && base !== name ? factsOf(base) : undefined;
  const body = creatureBodies.get(name);
  const facts = body ? creatureFacts(body, inherited) : inherited;
  creatureFactsOf.set(name, facts);
  return facts;
};
const creatures = Object.fromEntries(
  [...creatureBodies.keys()]
    .filter((name) => descends(name, 'BaseCreature'))
    .sort()
    .flatMap((name) => {
      const facts = factsOf(name);
      return facts ? [[name, facts]] : [];
    })
);
const output = new URL('./rules.json', import.meta.url).pathname;
const source = 'ServUO Server and Scripts at the pinned revision';
writeFileSync(
  output,
  `${JSON.stringify({ schemaVersion: 1, source, classes, sb, reagents, races, skills, maps, smallOre, water, harvest, doors, spellScrolls, manaByCircle, stations, world, gates })}\n`
);
writeFileSync(
  new URL('./creatures.json', import.meta.url).pathname,
  `${JSON.stringify({ schemaVersion: 1, source: 'ServUO Scripts/Mobiles constructors', creatures })}\n`
);
console.log(
  `${Object.keys(classes).length} classes, ${Object.keys(creatures).length} creatures, ${Object.keys(sb).length} vendor lists, ${races.length} races, ${skills.length} skills, ${Object.keys(maps).length} maps -> ${output}`
);
