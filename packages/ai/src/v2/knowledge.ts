import {
  alchemyTools,
  carpentryTools,
  cookingTools,
  fletchingTools,
  isDeathRobe,
  scribesPens,
  smithTools,
  tinkerTools,
  tongs
} from '@gemwright/common/game/items';
import {
  anvils,
  buys,
  classesShowing,
  creatures,
  doorGraphics,
  fishableWater,
  harvestOf,
  harvestTiles,
  heatSources,
  isA,
  npcTypes,
  sells,
  smithingForges,
  titled
} from '@gemwright/common/game/rules';

import { baselineTraits } from '../perception-reference';
import type { Spawner } from '../spawns';

const doors: ReadonlySet<number> = new Set(doorGraphics.flat());

// What a thing on screen could be, as a player who knows the game would recognise it: the item
// classes that look like it, or the creatures with that body and name.
export function identify(entity: {
  kind: 'mobile' | 'item';
  graphic: number;
  hue?: number;
  name?: string;
  properties?: readonly { cliloc: number; arguments: string }[];
}): string[] {
  if (entity.kind === 'mobile') {
    const reference = baselineTraits(entity.graphic, entity.name).value;
    if (!reference.humanLike) return reference.candidates.map((c) => c.type);
    // A townsperson's title, after its name in its hover (ServUO 1050045: prefix, name, suffix).
    const shown = entity.properties?.find((p) => p.cliloc === 1050045)?.arguments.split('\t')[2];
    return [...(shown ? titled(shown) : []), 'Person'];
  }
  if (isDeathRobe(entity)) return ['DeathRobe'];
  if (doors.has(entity.graphic)) return ['Door'];
  const looks = classesShowing(entity.graphic).filter((name) => isA(name, 'Item'));
  if (entity.properties) return described(looks, entity.properties);
  // Before its hover, its colour already tells the metal, as a player sees a valorite ingot.
  const metal = metalHues.get(entity.hue ?? 0);
  return metal ? ofMetal(looks, metal) : looks;
}

// The colour each metal gives its ore and ingots (ServUO ResourceInfo, CraftResourceInfo hues).
const metalHues = new Map([
  [0x000, 'Iron'],
  [0x973, 'DullCopper'],
  [0x966, 'ShadowIron'],
  [0x96d, 'Copper'],
  [0x972, 'Bronze'],
  [0x8a5, 'Gold'],
  [0x979, 'Agapite'],
  [0x89f, 'Verite'],
  [0x8ab, 'Valorite']
]);

// The metal a resource's hover names (ServUO CraftResources: its localized name, from Valorite
// 1053101 to Iron 1053109). Things of the standard metal name none: iron.
const metals = new Map([
  [1053101, 'Valorite'],
  [1053102, 'Verite'],
  [1053103, 'Agapite'],
  [1053104, 'Gold'],
  [1053105, 'Bronze'],
  [1053106, 'Copper'],
  [1053107, 'ShadowIron'],
  [1053108, 'DullCopper'],
  [1053109, 'Iron']
]);

// Of the kinds an item could be by its look, the one its hover (0xD6, what a player sees on
// mouse-over) says it is: an ore or ingot of the metal it names, iron when it names none.
function described(looks: string[], properties: readonly { cliloc: number }[]) {
  if (!looks.some((name) => isA(name, 'BaseOre') || isA(name, 'BaseIngot'))) return looks;
  return ofMetal(looks, properties.map((p) => metals.get(p.cliloc)).find((m) => m !== undefined) ?? 'Iron');
}

// An ore or ingot of one metal, of the kinds its look allows.
function ofMetal(looks: string[], metal: string) {
  if (!looks.some((name) => isA(name, 'BaseOre') || isA(name, 'BaseIngot'))) return looks;
  const kind = looks.some((name) => isA(name, 'BaseOre')) ? 'Ore' : 'Ingot';
  const exact = looks.filter((name) => name === `${metal}${kind}`);
  return exact.length ? exact : [`${metal}${kind}`];
}

let stocks: [string, ReadonlySet<number>][] | undefined;
// What kind of vendor offers this stock: the vendor types whose lists match what it shows best
// (shared goods over all goods of either),
// as a player tells a weaponsmith from a baker by the goods on the counter.
// The trades a person in view is known by (from its title), without the person it also is.
export const trades = (name: string | undefined) => (name ?? '').split('/').filter((type) => type && type !== 'Person');

export function identifyVendor(graphics: readonly number[]): string[] {
  stocks ??= npcTypes
    .map((type) => [type, new Set(sells(type).map((item) => item.graphic))] as [string, ReadonlySet<number>])
    .filter(([, sold]) => sold.size);
  const shown = new Set(graphics);
  const scored = stocks.map(([type, sold]) => {
    const both = [...shown].filter((g) => sold.has(g)).length;
    return [type, both / (shown.size + sold.size - both)] as const;
  });
  const best = Math.max(0, ...scored.map(([, score]) => score));
  return best ? scored.filter(([, score]) => score === best).map(([type]) => type) : [];
}

// What a player who read the wiki knows about a type: a creature's strength and what it carries,
// what a vendor sells and buys and at what price, and where the shard places it. A spawner says
// what may be somewhere, not what is.
export function know(type: string, spawners: readonly Spawner[]) {
  const creature = creatures.find((c) => c.type === type);
  const lower = type.toLowerCase();
  return {
    ...(creature
      ? {
          creature: Object.fromEntries(Object.entries(creature).filter(([key]) => key !== 'bodies' && key !== 'type'))
        }
      : {}),
    sells: sells(type),
    buys: buys(type),
    spawns: spawners.filter((s) => s.kinds.includes(lower)).map(({ x, y, map, range }) => ({ x, y, map, range }))
  };
}

// What a purchase or sale should change hands, from the vendor's lists and prices: the goods one way,
// their price in gold the other. Nothing when a price is not on the lists.
export function foreseeTrade(verb: 'buy' | 'sell', vendor: string, items: { name: string; amount: number }[]) {
  const vendors = vendor.split('/');
  const goods: Record<string, number> = {};
  let gold = 0;
  for (const { name, amount } of items) {
    const types = name.split('/');
    const price = vendors
      .flatMap((type) => (verb === 'buy' ? sells(type) : buys(type)))
      .find((item) => types.includes(item.type))?.price;
    if (price === undefined) return undefined;
    gold += price * amount;
    goods[name] = (goods[name] ?? 0) + amount;
  }
  return verb === 'buy' ? { gained: goods, lost: { Gold: gold } } : { gained: { Gold: gold }, lost: goods };
}

// Each harvest system (ServUO Mining.cs, Lumberjacking.cs, Fishing.cs): its resources, each with
// the skill it needs and the range its chance climbs over, and its veins, each a share of the world
// and its resource, falling back to the first half the time; and how many one success brings in Trammel.
type Resource = [type: string, required: number, min: number, max: number];
const harvests: Record<
  string,
  {
    skill: string;
    tiles: { land: number[]; statics: number[] };
    resources: Resource[];
    veins: [share: number, resource: number][];
    amount: number;
    bank: { width: number; height: number; respawn: number };
  }
> = {
  mining: {
    skill: 'Mining',
    bank: { width: 8, height: 8, respawn: 20 * 60_000 },
    tiles: harvestTiles.rock,
    resources: [
      ['IronOre', 0, 0, 100],
      ['DullCopperOre', 65, 25, 105],
      ['ShadowIronOre', 70, 30, 110],
      ['CopperOre', 75, 35, 115],
      ['BronzeOre', 80, 40, 120],
      ['GoldOre', 85, 45, 125],
      ['AgapiteOre', 90, 50, 130],
      ['VeriteOre', 95, 55, 135],
      ['ValoriteOre', 99, 59, 139]
    ],
    veins: [
      [49.6, 0],
      [11.2, 1],
      [9.8, 2],
      [8.4, 3],
      [7.0, 4],
      [5.6, 5],
      [4.2, 6],
      [2.8, 7],
      [1.4, 8]
    ],
    amount: 1
  },
  lumberjacking: {
    skill: 'Lumberjacking',
    bank: { width: 4, height: 3, respawn: 30 * 60_000 },
    tiles: harvestTiles.trees,
    resources: [
      ['Log', 0, 0, 100],
      ['OakLog', 65, 25, 105],
      ['AshLog', 80, 40, 120],
      ['YewLog', 95, 55, 135],
      ['HeartwoodLog', 100, 60, 140],
      ['BloodwoodLog', 100, 60, 140],
      ['FrostwoodLog', 100, 60, 140]
    ],
    veins: [
      [49, 0],
      [30, 1],
      [10, 2],
      [5, 3],
      [3, 4],
      [2, 5],
      [1, 6]
    ],
    amount: 10
  },
  fishing: {
    skill: 'Fishing',
    bank: { width: 8, height: 8, respawn: 20 * 60_000 },
    tiles: fishableWater,
    resources: [['Fish', 0, 0, 120]],
    veins: [[100, 0]],
    amount: 1
  }
};

// The tiles each kind of harvest works.
export const harvestKinds = () => Object.values(harvests).map((harvest) => harvest.tiles);

// The harvest a tool works, and the tiles it works on.
export function harvestBy(tool: string) {
  const system = tool
    .split('/')
    .map((type) => harvestOf(type))
    .find((found) => found !== undefined);
  return system ? harvests[system] : undefined;
}

// What a tool brings from a tile it harvests: each resource's amount by the chance of digging it
// (ServUO SkillCheck, (skill - min) / (max - min)). Nothing when the tile is not one the tool works.
export function foreseeHarvest(
  tool: string,
  target: { tile?: number; land?: number },
  skill: (name: string) => number,
  skillTotal?: number
) {
  const def = harvestBy(tool);
  if (!def) return undefined;
  const works =
    target.tile !== undefined ? def.tiles.statics.includes(target.tile) : def.tiles.land.includes(target.land ?? -1);
  if (!works) return undefined;
  // An unknown vein: each by its share, its resource unless it falls back (ServUO MutateResource),
  // gained with the chance its skill has (CheckHarvestSkill).
  const value = skill(def.skill);
  const gained: Record<string, number> = {};
  const total = def.veins.reduce((sum, [share]) => sum + share, 0);
  for (const [share, index] of def.veins) {
    const reached = ([, required, min]: Resource) => value >= required && value >= min;
    const primary = def.resources[index] as Resource;
    const fallback = def.resources[0] as Resource;
    const own = index && reached(primary) ? 0.5 : index ? 0 : 1;
    for (const [resource, part] of [
      [primary, own],
      [fallback, index ? 1 - own : 0]
    ] as const) {
      const [type, required, min, max] = resource;
      const chance = value >= required ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
      if (part && chance) gained[type] = (gained[type] ?? 0) + (share / total) * part * chance * def.amount;
    }
  }
  const [, , min, max] = def.resources[0] as Resource;
  const learned = skillTotal === undefined ? {} : gaining(def.skill, value, skillTotal, (value - min) / (max - min));
  return { gained, ...learned };
}

// What one use of a skill is expected to teach (ServUO SkillCheck.GetGainChance, AOS): a tenth of a
// point, as likely as there is room left in the skill and under the skill total's cap (700), more
// so when it succeeds against the odds.
export function gaining(skill: string, value: number, total: number, odds: number) {
  const chance = Math.min(1, Math.max(0, odds));
  const room = ((700 - total) / 700 + (100 - value) / 100) / 2;
  const gain = (success: boolean) => Math.min(1, Math.max(0.01, (room + (success ? (1 - chance) * 0.5 : 0)) / 2)) * 0.1;
  const expected = chance * gain(true) + (1 - chance) * gain(false);
  return value >= 100 ? {} : { skill: expected, skills: { [skill]: expected } };
}

// Smelting ore at a forge (ServUO Ore.cs): each ore's difficulty, its Mining chance over 25 either
// side of it; a success turns the whole pile to ingots (half as many from the smallest ore, twice as
// many from the largest), a failure burns away half of it. Ore harder than its Mining is refused.
const smelting: Record<string, number> = {
  IronOre: 50,
  DullCopperOre: 65,
  ShadowIronOre: 70,
  CopperOre: 75,
  BronzeOre: 80,
  GoldOre: 85,
  AgapiteOre: 90,
  VeriteOre: 95,
  ValoriteOre: 99
};
// The forges a target may be (Ore.cs IsForge): its static graphics.
export const isForge = (graphic: number) => graphic === 4017 || (graphic >= 6522 && graphic <= 6569);
// A fixed station a trade works at (the rules' stations: anvils, smithing forges and heat). What a
// tool whose use asks for a target can be used on, whatever the trade.
export const isStation = (graphic: number) =>
  anvils.has(graphic) || smithingForges.has(graphic) || heatSources.has(graphic);
export function foreseeSmelt(ore: string, amount: number, graphic: number, mining: number, total?: number) {
  const difficulty = smelting[ore];
  if (difficulty === undefined || (difficulty > 50 && difficulty > mining)) return { gained: {}, lost: {} };
  const chance = Math.min(1, Math.max(0, (mining - (difficulty - 25)) / 50));
  const ingots = graphic === 0x19b7 ? Math.floor(amount / 2) : graphic === 0x19b9 ? amount * 2 : amount;
  const used = graphic === 0x19b7 ? amount - (amount % 2) : amount;
  return {
    gained: { [ore.replace(/Ore$/, 'Ingot')]: chance * ingots },
    lost: { [ore]: chance * used + (1 - chance) * Math.floor(amount / 2) },
    ...(total === undefined ? {} : gaining('Mining', mining, total, chance))
  };
}

// What harvesting turns up besides its resource (ServUO Mining.cs and Lumberjacking.cs bonus
// resources): crafting materials no vendor buys, kept in the bank (uoguide.com/Gems).
const keepsakes: ReadonlySet<string> = new Set([
  'BlueDiamond',
  'DarkSapphire',
  'EcruCitrine',
  'FireRuby',
  'PerfectEmerald',
  'Turquoise',
  'CrystallineBlackrock',
  'SmallPieceofBlackrock',
  'BarkFragment',
  'BrilliantAmber',
  'CrystalShards',
  'LuminescentFungi',
  'ParasiticPlant',
  'SwitchItem'
]);
export const isKeepsake = (name: string) => name.split('/').some((type) => keepsakes.has(type));

// What a hover says, as a player reads it (ServUO Item, BaseWeapon and BaseArmor properties): what
// the whole pile weighs (1072788/1072789), blessed (1038021) or exceptional (1060636), a weapon's
// damage (1061168) and seconds a swing (1061167), the strength it needs (1061170), its resistances
// (physical 1060448, fire 1060447, cold 1060445, poison 1060449, energy 1060446) and durability
// (1060639). What it does not say is left out.
export interface Facts {
  contents?: { count: number; max?: number };
  weight?: number;
  blessed?: boolean;
  exceptional?: boolean;
  damage?: [number, number];
  speed?: number;
  strength?: number;
  resists?: Partial<Record<'physical' | 'fire' | 'cold' | 'poison' | 'energy', number>>;
  durability?: [number, number];
}
const resistances = new Map<number, 'physical' | 'fire' | 'cold' | 'poison' | 'energy'>([
  [1060448, 'physical'],
  [1060447, 'fire'],
  [1060445, 'cold'],
  [1060449, 'poison'],
  [1060446, 'energy']
]);
export function facts(properties: readonly { cliloc: number; arguments: string }[]): Facts {
  const found: Facts = {};
  const numbers = (text: string) => text.split('\t').map((part) => Number.parseFloat(part));
  for (const { cliloc, arguments: text } of properties) {
    const [a = Number.NaN, b = Number.NaN] = numbers(text);
    if (cliloc === 1072788 || cliloc === 1072789) found.weight = a;
    else if (cliloc === 1073841 || cliloc === 1072241) found.contents = { count: a, max: b };
    else if (cliloc === 1050044) found.contents = { count: a };
    else if (cliloc === 1038021) found.blessed = true;
    else if (cliloc === 1060636) found.exceptional = true;
    else if (cliloc === 1061168) found.damage = [a, b];
    else if (cliloc === 1061167) found.speed = a;
    else if (cliloc === 1061170) found.strength = a;
    else if (cliloc === 1060639) found.durability = [a, b];
    else {
      const resist = resistances.get(cliloc);
      if (resist) found.resists = { ...found.resists, [resist]: a };
    }
  }
  return found;
}

// The tools a craft works with (each craft's menu opener, and the smith's tongs): kept, not banked.
export const tools: ReadonlySet<number> = new Set(
  [alchemyTools, fletchingTools, tinkerTools, carpentryTools, cookingTools, scribesPens, smithTools, tongs].flatMap(
    (set) => [...set]
  )
);
