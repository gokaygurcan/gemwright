import creaturesJson from './creatures.json';
import rulesJson from './rules.json';
import type { CreatureFacts } from './rules-creatures';

// The Rules layer: facts of the pinned ServUO (rules.json, build-rules.ts), read through its class
// inheritance as ServUO reads them. Everything the residents know about items, tools, vendors,
// bodies, skills and maps comes from here, not from lists kept by hand.
interface ClassFacts {
  b: string;
  c?: string;
  rw?: [string, number, number];
  i?: string[];
  g?: number[];
  h?: string;
  own?: 1;
  s?: string;
  r?: 1;
  hue?: number;
  bodies?: number[];
  sb?: string[];
}
type Tiles = { land: number[]; statics: number[] };
type BySex = { female: number[]; male: number[] };
interface Rules {
  classes: Record<string, ClassFacts>;
  sb: Record<string, { sells: [string, number, number][]; buys: [string, number][] }>;
  reagents: { magery: string[]; necromancy: string[] };
  races: {
    name: string;
    male: number;
    female: number;
    maleGhost: number;
    femaleGhost: number;
    hair: BySex;
    beards: BySex;
    skins: number[];
    hairHues: number[];
  }[];
  skills: { name: string; label: string }[];
  maps: Record<string, { name: string; width: number; height: number }>;
  smallOre: number;
  water: Tiles;
  doors: [number, number][];
  spellScrolls: Record<string, number>;
  manaByCircle: number[];
  world: { roads: number[]; houseKey: number; bodyParts: string[]; fished: string[] };
  stations: { anvils: number[]; forges: number[]; smelting: number[]; heat: number[] };
  harvest: { trees: Tiles; rock: Tiles; ores: { type: string; skill: number; hue: number }[] };
}
const data = rulesJson as unknown as Rules;
const classes = data.classes;
const lists = data.sb;
export const races = data.races;
export const ruleSkills = data.skills;
export const ruleMaps = data.maps;
export const reagentNames = data.reagents;
export const smallOre = data.smallOre;
export const fishableWater = data.water;
// What lumberjacking and mining tools work on (Lumberjacking.cs, Mining.cs), and the ores mining yields.
export const harvestTiles = data.harvest;
// Each door's closed and open graphics (ServUO door classes and Data/Components/doors.txt).
export const doorGraphics = data.doors;
// The scroll of a spell, by the spell's number as clients cast it (ServUO's 0-based id plus one).
export const scrollOf = (spell: number) => data.spellScrolls[spell - 1];
// Mana a Magery spell of a circle (1-8) costs.
export const manaOf = (circle: number) => data.manaByCircle[circle - 1] ?? 0;
// Anvils and forges smiths work at, and the forges ore smelts at (DefBlacksmithy.cs, Ore.cs).
export const anvils: ReadonlySet<number> = new Set(data.stations.anvils);
export const smithingForges: ReadonlySet<number> = new Set(data.stations.forges);
export const smeltingForges: ReadonlySet<number> = new Set(data.stations.smelting);
export const heatSources: ReadonlySet<number> = new Set(data.stations.heat);
// Land a house may not cover, a new house's key, the body parts and bones creatures carry, and the
// things fishing brings up besides fish.
export const houseRoads: ReadonlySet<number> = new Set(data.world.roads);
export const houseKey = data.world.houseKey;
export const bodyParts = data.world.bodyParts;
export const fishedTypes = data.world.fished;
export const spellScrollGraphics: ReadonlySet<number> = new Set(Object.values(data.spellScrolls));
// Trammel's public moongates by ServUO's own name for each (PublicMoongate.cs), typed by their names.
export const moongateList = rulesJson.gates;

const ancestors = (name: string) => {
  const chain: string[] = [];
  for (let at = name; classes[at] && !chain.includes(at); at = classes[at]?.b ?? '') chain.push(at);
  return chain;
};
// The first fact along the class and its bases.
const inherited = <T>(name: string, pick: (facts: ClassFacts) => T | undefined) => {
  for (const at of ancestors(name)) {
    const value = pick(classes[at] as ClassFacts);
    if (value !== undefined) return value;
  }
  return undefined;
};
export const isA = (name: string, root: string) =>
  ancestors(name).some((at) => at === root || classes[at]?.i?.includes(root)) || classes[name]?.b === root;
export const kindsOf = (root: string) => Object.keys(classes).filter((name) => isA(name, root));
export const graphicsOf = (name: string): number[] => inherited(name, (f) => (f.g?.length ? f.g : undefined)) ?? [];
export const graphicOf = (name: string) => {
  const graphic = graphicsOf(name)[0];
  if (graphic === undefined) throw new Error(`ServUO rules have no graphic for ${name}`);
  return graphic;
};
// Every graphic of a class and all its kinds.
export const graphicsOfKinds = (root: string): ReadonlySet<number> =>
  new Set([root, ...kindsOf(root)].flatMap((name) => graphicsOf(name)));
export const hueOf = (name: string) => inherited(name, (f) => f.hue);
export const skillOf = (name: string) => inherited(name, (f) => f.s);
export const gargoyleOnly = (name: string) => ancestors(name).some((at) => classes[at]?.r);
export const bodiesOf = (name: string): number[] => inherited(name, (f) => f.bodies) ?? [];
// The harvest system a class works when used: its own, else its base's, unless it is used its own
// Ranged weapons by graphic: the ammunition each fires, its reach and seconds per shot (ServUO
// BaseRanged classes: AmmoType, DefMaxRange, MlSpeed).
export const rangedWeapons = () =>
  kindsOf('BaseRanged').flatMap((type) => {
    const stats = inherited(type, (f) => f.rw);
    return stats
      ? graphicsOf(type).map((graphic) => ({ type, graphic, ammo: stats[0], range: stats[1], seconds: stats[2] }))
      : [];
  });
// The tools that open a craft system's menu (DefAlchemy: the mortar and pestle).
export const craftTools = (system: string): ReadonlySet<number> =>
  new Set(
    Object.keys(classes)
      .filter((name) => inherited(name, (f) => f.c) === system)
      .flatMap(graphicsOf)
  );
// way (an OnDoubleClick of its own that names no system: ServUO's Hoe is a BaseAxe that plants).
export function harvestOf(name: string) {
  for (const at of ancestors(name)) {
    const facts = classes[at] as ClassFacts;
    if (facts.h) return facts.h;
    if (facts.own) return undefined;
  }
  return undefined;
}

// What an NPC type sells and buys: its vendor lists (its own, else its base's).
export const listsOf = (npc: string): string[] => inherited(npc, (f) => (f.sb?.length ? f.sb : undefined)) ?? [];
export const vendorListNames = Object.keys(lists);
export const sells = (npc: string) =>
  listsOf(npc).flatMap((list) =>
    (lists[list]?.sells ?? []).map(([type, price, graphic]) => ({ type, price, graphic }))
  );
export const buys = (npc: string) =>
  listsOf(npc).flatMap((list) => (lists[list]?.buys ?? []).map(([type, price]) => ({ type, price })));
// A type's graphics, with any other graphic a vendor list shows it as (SBTanner's Backpack as 0x9B2).
export const graphicsListed = (type: string): ReadonlySet<number> =>
  new Set([
    ...graphicsOf(type),
    ...Object.values(lists).flatMap((list) =>
      list.sells.filter(([sold]) => sold === type).map(([, , graphic]) => graphic)
    )
  ]);
// The graphic a vendor list shows a type as (what a buy offer carries), else its own.
export const soldAs = (type: string) =>
  Object.values(lists)
    .flatMap((list) => list.sells)
    .find(([sold]) => sold === type)?.[2] ?? graphicOf(type);
// The least any shop pays for a type and charges for it (its vendor lists' buy and sell prices).
export function shopPrices(type: string) {
  const all = Object.values(lists);
  const paid = all.flatMap((list) => list.buys.filter(([t]) => t === type).map(([, price]) => price));
  const charged = all.flatMap((list) => list.sells.filter(([t]) => t === type).map(([, price]) => price));
  return { pays: paid.length ? Math.min(...paid) : 0, charges: charged.length ? Math.min(...charged) : 0 };
}
// Every type some vendor list buys back.
export const boughtTypes: ReadonlySet<string> = new Set(
  Object.values(lists).flatMap((list) => list.buys.map(([type]) => type))
);
// Every NPC type with vendor lists, banking or healing.
export const npcTypes = Object.keys(classes).filter(
  (name) => listsOf(name).length || isA(name, 'Banker') || name === 'Banker' || isA(name, 'BaseHealer')
);
export const banks = (npc: string) => npc === 'Banker' || isA(npc, 'Banker');
export const heals = (npc: string) => isA(npc, 'BaseHealer');
// Every ServUO creature's facts (rules-creatures.ts) with the bodies it wears and whether it is ridden.
export const creatures = Object.entries(
  (creaturesJson as unknown as { creatures: Record<string, CreatureFacts> }).creatures
).map(([type, facts]) => ({
  type,
  ...facts,
  bodies: bodiesOf(type),
  mount: isA(type, 'BaseMount')
}));
