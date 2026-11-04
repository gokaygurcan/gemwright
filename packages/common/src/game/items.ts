import {
  boughtTypes,
  buys,
  craftTools,
  gargoyleOnly,
  graphicOf,
  graphicsOf,
  graphicsOfKinds,
  harvestOf,
  hueOf,
  isA,
  kindsOf,
  npcTypes,
  reagentNames,
  sells,
  skillOf,
  smallOre,
  soldAs
} from './rules';

// Item graphics shared across packages, read from the ServUO rules (rules.ts): each is the graphic
// of a ServUO class, or of a class and all its kinds.
export const gold = graphicOf('Gold');

// Work tools, by the graphics a player may hold.
export const instruments = graphicsOfKinds('BaseInstrument');
// Magic fish (ServUO MagicFish.cs): eaten whole for a blessing; no vendor buys one.
export const magicFish = graphicsOfKinds('BaseMagicFish');
export const sewingKit = graphicOf('SewingKit');

// Supplies a fighter or mage runs out of.
export const bandage = graphicOf('Bandage');
export const healPotion = graphicOf('GreaterHealPotion');
export const arrow = graphicOf('Arrow');
export const bolt = graphicOf('Bolt');
// The reagents the Magery and Necromancy spells use, by ServUO type name, and as a set of graphics.
const byName = (names: readonly string[]): Readonly<Record<string, number>> =>
  Object.fromEntries(names.map((name) => [name, graphicOf(name)]));
export const reagentByName = byName(reagentNames.magery);
export const reagents = new Set(Object.values(reagentByName));
export const necroReagentByName = byName(reagentNames.necromancy);

// The robe ServUO puts on a resurrected character (DeathRobe: its graphics and hue). Not the
// ghost's death shroud.
const deathRobe = new Set(graphicsOf('DeathRobe'));
const deathRobeHue = hueOf('DeathRobe');
export const isDeathRobe = (item: { graphic: number; hue?: number }) =>
  deathRobe.has(item.graphic) && item.hue === deathRobeHue;

// Gems a miner digs up or a fighter loots, kept in the bank: what jewelers buy that is not jewelry.
export const gems: ReadonlySet<number> = new Set(
  npcTypes
    .filter((npc) => npc === 'Jeweler' || isA(npc, 'Jeweler'))
    .flatMap((npc) => buys(npc))
    .filter(({ type }) => !isA(type, 'BaseJewel'))
    .flatMap(({ type }) => graphicsOf(type))
);

// Ore piles, every size (BaseOre and its kinds).
export const ore = graphicsOfKinds('BaseOre');

// Melee weapons some vendor sells, by the skill each uses (its DefSkill, else its base's), the
// gargoyle-only ones apart. Mining tools that count as weapons (pickaxes) are tools, not arms.
type CombatSkill = 'Swordsmanship' | 'Fencing' | 'Mace Fighting';
const combat: Record<string, CombatSkill> = { Swords: 'Swordsmanship', Fencing: 'Fencing', Macing: 'Mace Fighting' };
const sold = [...new Set(npcTypes.flatMap((npc) => sells(npc).map(({ type }) => type)))].filter(
  (type) => isA(type, 'BaseMeleeWeapon') && harvestOf(type) !== 'mining'
);
const weaponsBy = (gargish: boolean): Readonly<Record<CombatSkill, readonly number[]>> => {
  const by: Record<CombatSkill, number[]> = { Swordsmanship: [], Fencing: [], 'Mace Fighting': [] };
  for (const type of sold) {
    const skill = combat[skillOf(type) ?? ''];
    if (skill && gargoyleOnly(type) === gargish) by[skill].push(...graphicsOf(type));
  }
  return Object.fromEntries(Object.entries(by).map(([skill, graphics]) => [skill, [...new Set(graphics)]])) as Record<
    CombatSkill,
    number[]
  >;
};
export const weapons = weaponsBy(false);
export const gargishWeapons = weaponsBy(true);

// Common goods the residents move, sell and wear.
export const ingot = graphicOf('IronIngot');
export const board = graphicOf('Board');
export const logPile = graphicOf('Log');
export const crossbowBolt = bolt;
export const corpse = graphicOf('Corpse');
export const bulkOrderDeed = graphicOf('SmallBOD');
export const moongate = graphicOf('PublicMoongate');

// Item-property labels the AI reads. Which properties make a piece valuable is policy (the AI's
// item-quality.ts); the numbers are the shard's vocabulary.
export const ItemProperty = {
  exceptional: 1060636,
  artifact: 1061078,
  blessed: 1038021,
  // The labels fighter-gear.ts and inventory-use.ts read to decide what a piece is worth.
  durability: 1060639, // durability ~1_val~ / ~2_val~
  weaponDamage: 1061168, // weapon damage ~1_val~ - ~2_val~
  weaponSpeed: 1061167, // weapon speed ~1_val~
  strengthRequirement: 1061170, // strength requirement ~1_val~
  twoHanded: 1061171, // two-handed weapon
  swingSpeedIncrease: 1060486, // swing speed increase ~1_val~%
  corpseOf: 1046414 // the remains of ~1_NAME~
} as const;

// The ore pile ServUO smelts only two or more of together.
export const smallOrePile = smallOre;
export const cloth = graphicOf('Cloth');
export const uncutCloth = graphicOf('UncutCloth');
export const boltOfCloth = graphicOf('BoltOfCloth');

// Containers inside a pack, opened to see what they hold.
export const backpack = graphicOf('Backpack');
export const bag = graphicOf('Bag');
export const pouch = graphicOf('Pouch');
export const containers: ReadonlySet<number> = graphicsOfKinds('BaseContainer');

// Goods by every graphic they show; each is the same item.
export const logs = graphicsOfKinds('BaseLog');
export const boards = graphicsOfKinds('BaseWoodBoard');
export const hides = graphicsOfKinds('BaseHides');
export const sand: ReadonlySet<number> = new Set(graphicsOf('Sand'));
export const scissors: ReadonlySet<number> = new Set(graphicsOf('Scissors'));

// The BaseAxe weapon family (pickaxes included): a miner always carries a valid Arms Lore target.
export const axeWeapons = graphicsOfKinds('BaseAxe');

export const spellbook = graphicOf('Spellbook');
export const bottle = graphicOf('Bottle');
export const curePotion = graphicOf('GreaterCurePotion');
export const poisonPotion = graphicOf('PoisonPotion');
export const rawSteak = graphicOf('RawFishSteak');

// Everything a fisher hauls in: plain fish, the High Seas fish (each carves into steaks) and the
// raw steak a fish carves into.
export const fish: ReadonlySet<number> = new Set([
  ...graphicsOfKinds('Fish'),
  ...graphicsOfKinds('BaseHighseasFish'),
  rawSteak
]);

// Cutting blades: every knife (BaseKnife and its kinds).
export const blades = graphicsOfKinds('BaseKnife');
export const scrolls = graphicsOfKinds('SpellScroll');
export const shields = graphicsOfKinds('BaseShield');
// Each craft's tools (the menu they open).
export const alchemyTools = craftTools('DefAlchemy');
export const fletchingTools = craftTools('DefBowFletching');
export const tinkerTools = craftTools('DefTinkering');
export const carpentryTools = craftTools('DefCarpentry');
export const cookingTools = craftTools('DefCooking');
export const scribesPens = craftTools('DefInscription');
export const smithTools = craftTools('DefBlacksmithy');
export const tongs: ReadonlySet<number> = new Set(graphicsOf('Tongs'));
export const blankScroll = soldAs('BlankScroll');
export const runebook = graphicOf('Runebook');
export const recallRune = graphicOf('RecallRune');
export const repairDeed = graphicOf('RepairDeed');
export const wool = graphicOf('Wool');
export const yarn: ReadonlySet<number> = new Set(['DarkYarn', 'LightYarn', 'LightYarnUnraveled'].flatMap(graphicsOf));
export const boneArmor: ReadonlySet<number> = new Set(
  kindsOf('BaseArmor')
    .filter((type) => type.startsWith('Bone'))
    .flatMap(graphicsOf)
);
// What some shop buys back.
export const shopBought: ReadonlySet<number> = new Set([...boughtTypes].flatMap(graphicsOf));
