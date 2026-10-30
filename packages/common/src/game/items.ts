// Item graphics shared across packages.
export const gold = 0x0eed; // gold coin pile

// Work tools, by the graphics a player may hold.
export const instruments = new Set([
  0x0e9c, // drums
  0x0e9d, // tambourine (alternate)
  0x0e9e, // tambourine
  0x0eb1, // standing harp
  0x0eb2, // lap harp
  0x0eb3 // lute
]);
export const hatchets = new Set([
  0x0f43, // hatchet
  0x0f44, // hatchet (alternate)
  0x0f47, // battle axe
  0x0f48, // battle axe (alternate)
  0x0f49, // axe
  0x0f4a, // axe (alternate)
  0x13fa, // large battle axe
  0x13fb, // large battle axe (alternate)
  0x08fd // dual short axes (a gargoyle lumberjack's starting axe)
]);
export const miningTools = new Set([
  0x0e85, // pickaxe
  0x0e86, // pickaxe (alternate)
  0x0f39, // shovel
  0x0f3a // shovel (alternate)
]);
export const fishingPoles = new Set([
  0x0dbf, // fishing pole, facing east
  0x0dc0 // fishing pole, facing south
]);
// Magic fish (ServUO MagicFish.cs): one graphic in four hues — prized (intelligence), wondrous
// (dexterity), truly rare (strength) and peculiar (stamina). Eaten whole for the blessing, whose
// size and duration the shard decides; no vendor buys one, so carrying one is all weight.
export const magicFish = new Set([0x0dd6]);
export const sewingKit = 0x0f9d;

// Supplies a fighter or mage runs out of.
export const bandage = 0x0e21;
export const healPotion = 0x0f0c; // greater heal potion
export const arrow = 0x0f3f;
export const bolt = 0x1bfb; // crossbow bolt
// Magery reagents by their ServUO type name, and as a set of graphics.
export const reagentByName: Readonly<Record<string, number>> = {
  BlackPearl: 0x0f7a, // black pearl
  Bloodmoss: 0x0f7b, // bloodmoss
  Garlic: 0x0f84, // garlic
  Ginseng: 0x0f85, // ginseng
  MandrakeRoot: 0x0f86, // mandrake root
  Nightshade: 0x0f88, // nightshade
  SulfurousAsh: 0x0f8c, // sulfurous ash
  SpidersSilk: 0x0f8d // spider's silk
};
export const reagents = new Set(Object.values(reagentByName));

// The robe ServUO puts on a resurrected character (DeathRobe: a robe, hue 2301, newbied). Not the
// ghost's death shroud (0x204e).
const deathRobeGraphics = new Set([
  0x1f03, // robe
  0x2687 // robe (alternate)
]);
export const isDeathRobe = (item: { graphic: number; hue?: number }) =>
  deathRobeGraphics.has(item.graphic) && item.hue === 2301;

// Gems a miner digs up or a fighter loots: kept in the bank, not carried around.
export const gems = new Set([
  0x0f0f, // star sapphire
  0x0f10, // emerald
  0x0f11, // sapphire
  0x0f13, // ruby
  0x0f15, // citrine
  0x0f16, // amethyst
  0x0f18, // tourmaline
  0x0f25, // amber
  0x0f26, // diamond
  0x3192, // dark sapphire
  0x3193, // turquoise
  0x3194, // perfect emerald
  0x3195, // ecru citrine
  0x3196, // white pearl
  0x3197, // fire ruby
  0x3198, // blue diamond
  0x3199 // brilliant amber
]);

// Ore piles (ServUO Ore.cs ItemIDs), by size.
export const ore = new Set([
  0x19b7, // small pile (smelts only two or more)
  0x19b8, // medium pile
  0x19b9, // large pile
  0x19ba // medium pile (alternate)
]);

// Gargish weapons (ServUO Scripts/Items/Equipment/Weapons, SA): the only ones a gargoyle can
// wield, by the skill each uses (the base class's, or the weapon's own DefSkill). Graphics in the
// 0x48xx range come in pairs (the flipped one next to it).
export const gargishWeapons: Readonly<Record<'Swordsmanship' | 'Fencing' | 'Mace Fighting', readonly number[]>> = {
  Swordsmanship: [
    0x0908, // gargish talwar
    0x090c, // glass sword
    0x0900, // stone war sword
    0x08fd, // dual short axes
    0x48ae, // gargish cleaver
    0x48af, // gargish cleaver (flipped)
    0x48b0, // gargish battle axe
    0x48b1, // gargish battle axe (flipped)
    0x48b2, // gargish axe
    0x48b3, // gargish axe (flipped)
    0x48b4, // gargish bardiche
    0x48b5, // gargish bardiche (flipped)
    0x48b6, // gargish butcher knife
    0x48b7, // gargish butcher knife (flipped)
    0x48ba, // gargish katana
    0x48bb, // gargish katana (flipped)
    0x48c4, // gargish scythe
    0x48c5, // gargish scythe (flipped)
    0x48c6, // gargish bone harvester
    0x48c7 // gargish bone harvester (flipped)
  ],
  Fencing: [
    0x0902, // gargish dagger
    0x08fe, // blood blade
    0x0907, // shortblade
    0x0904, // dual pointed spear
    0x48bc, // gargish kryss
    0x48bd, // gargish kryss (flipped)
    0x48be, // gargish war fork
    0x48bf, // gargish war fork (flipped)
    0x48c8, // gargish pike
    0x48c9, // gargish pike (flipped)
    0x48ca, // gargish lance
    0x48cb, // gargish lance (flipped)
    0x48ce, // gargish tekagi
    0x48cf // gargish tekagi (flipped)
  ],
  'Mace Fighting': [
    0x0903, // disc mace
    0x0905, // glass staff
    0x0906, // serpent stone staff
    0x48b8, // gargish gnarled staff
    0x48b9, // gargish gnarled staff (flipped)
    0x48c0, // gargish war hammer
    0x48c1, // gargish war hammer (flipped)
    0x48c2, // gargish maul
    0x48c3, // gargish maul (flipped)
    0x48cc, // gargish tessen
    0x48cd // gargish tessen (flipped)
  ]
};

// Necromancy reagents by their ServUO type name (sold by the mage since AOS).
export const necroReagentByName: Readonly<Record<string, number>> = {
  BatWing: 0x0f78, // bat wing
  DaemonBlood: 0x0f7d, // daemon blood
  PigIron: 0x0f8a, // pig iron
  NoxCrystal: 0x0f8e, // nox crystal
  GraveDust: 0x0f8f // grave dust
};

// Melee weapons by combat skill (ServUO item IDs, both facings; each weapon's DefSkill in
// Scripts/Items/Equipment/Weapons). Tools that count as weapons (pickaxe, hatchet, knives,
// cleaver, crook, pitchfork, wand) and gargish weapons (gargishWeapons) are left out.
export const weapons: Readonly<Record<'Swordsmanship' | 'Fencing' | 'Mace Fighting', readonly number[]>> = {
  Swordsmanship: [
    0x0f49, // axe
    0x0f4a, // axe
    0x0f4d, // bardiche
    0x0f4e, // bardiche
    0x0f47, // battle axe
    0x0f48, // battle axe
    0x26bd, // bladed staff
    0x26c7, // bladed staff
    0x27a8, // bokuto
    0x27f3, // bokuto
    0x26bb, // bone harvester
    0x26c5, // bone harvester
    0x0f5e, // broadsword
    0x0f5f, // broadsword
    0x26c1, // crescent blade
    0x26cb, // crescent blade
    0x1440, // cutlass
    0x1441, // cutlass
    0x27a9, // daisho
    0x27f4, // daisho
    0x0f4b, // double axe
    0x0f4c, // double axe
    0x2d29, // elven machete
    0x2d35, // elven machete
    0x0f45, // executioner's axe
    0x0f46, // executioner's axe
    0x143e, // halberd
    0x143f, // halberd
    0x13fe, // katana
    0x13ff, // katana
    0x13fa, // large battle axe
    0x13fb, // large battle axe
    0x0f60, // longsword
    0x0f61, // longsword
    0x27a2, // no-dachi
    0x27ed, // no-dachi
    0x2d28, // ornate axe
    0x2d34, // ornate axe
    0x26ce, // paladin sword
    0x26cf, // paladin sword
    0x2d27, // radiant scimitar
    0x2d33, // radiant scimitar
    0x2d26, // rune blade
    0x2d32, // rune blade
    0x13b5, // scimitar
    0x13b6, // scimitar
    0x26ba, // scythe
    0x26c4, // scythe
    0x13b7, // thin longsword
    0x13b8, // thin longsword
    0x1442, // two-handed axe
    0x1443, // two-handed axe
    0x13b9, // viking sword
    0x13ba, // viking sword
    0x27a4, // wakizashi
    0x27ef // wakizashi
  ],
  Fencing: [
    0x2d21, // assassin spike
    0x2d2d, // assassin spike
    0x0f51, // dagger
    0x0f52, // dagger
    0x26bf, // double bladed staff
    0x26c9, // double bladed staff
    0x2d20, // elven spellblade
    0x2d2c, // elven spellblade
    0x27ad, // kama
    0x27f8, // kama
    0x1400, // kryss
    0x1401, // kryss
    0x27a7, // lajatang
    0x27f2, // lajatang
    0x26c0, // lance
    0x26ca, // lance
    0x2d22, // leafblade
    0x2d2e, // leafblade
    0x26be, // pike
    0x26c8, // pike
    0x27af, // sai
    0x27fa, // sai
    0x1402, // short spear
    0x1403, // short spear
    0x0f62, // spear
    0x0f63, // spear
    0x27ab, // tekagi
    0x27f6, // tekagi
    0x2d23, // war cleaver
    0x2d2f, // war cleaver
    0x1404, // war fork
    0x1405 // war fork
  ],
  'Mace Fighting': [
    0x0df0, // black staff
    0x0df1, // black staff
    0x13b3, // club
    0x13b4, // club
    0x2d24, // diamond mace
    0x2d30, // diamond mace
    0x13f8, // gnarled staff
    0x13f9, // gnarled staff
    0x143c, // hammer pick
    0x143d, // hammer pick
    0x0f5c, // mace
    0x0f5d, // mace
    0x143a, // maul
    0x143b, // maul
    0x27ae, // nunchaku
    0x27f9, // nunchaku
    0x0e89, // quarter staff
    0x0e8a, // quarter staff
    0x26bc, // scepter
    0x26c6, // scepter
    0x27a3, // tessen
    0x27ee, // tessen
    0x27a6, // tetsubo
    0x27f1, // tetsubo
    0x13af, // war axe
    0x13b0, // war axe
    0x1438, // war hammer
    0x1439, // war hammer
    0x1406, // war mace
    0x1407, // war mace
    0x2d25, // wild staff
    0x2d31 // wild staff
  ]
};

// Common goods the residents move, sell and wear.
export const ingot = 0x1bf2;
export const board = 0x1bd7;
export const logPile = 0x1bdd;
export const crossbowBolt = 0x1bfb;
export const corpse = 0x2006;
export const bulkOrderDeed = 0x2258;
export const moongate = 0x0f6c;

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

// The smallest ore pile: ServUO smelts it only when two or more are held together.
export const smallOrePile = 0x19b7;
export const cloth = 0x1766;
export const uncutCloth = 0x1767;
export const boltOfCloth = 0x0f95;

// Containers inside a pack, opened to see what they hold.
export const backpack = 0x0e75;
export const bag = 0x0e76;
export const pouch = 0x0e79;
export const leatherPouch = 0x09b0;
export const containers: ReadonlySet<number> = new Set([backpack, bag, pouch, leatherPouch]);

// Goods that come in two facing art variants; both are the same item.
export const logs: ReadonlySet<number> = new Set([0x1bdd, 0x1be0]);
export const boards: ReadonlySet<number> = new Set([0x1bd7, 0x1bd8]);
export const hides: ReadonlySet<number> = new Set([0x1078, 0x1079]);
export const sand: ReadonlySet<number> = new Set([0x11ea, 0x11eb]);

// Tailor's scissors, both facings.
export const scissors: ReadonlySet<number> = new Set([0x0f9e, 0x0f9f]);

// The BaseAxe weapon family (pickaxes included): a miner always carries a valid Arms Lore target.
export const axeWeapons: ReadonlySet<number> = new Set([
  0x0e85, 0x0e86, 0x0f43, 0x0f44, 0x0f49, 0x0f4a, 0x13b9, 0x13ba, 0x0f51, 0x0f52, 0x1b72, 0x1b73
]);

// A spellbook (magery and inscription use the same graphic) and an empty bottle.
export const spellbook = 0x0efa;
export const bottle = 0x0f0e;

// Potions and the raw steak a fish carves into.
export const curePotion = 0x0f07;
export const poisonPotion = 0x0f0a;
export const rawSteak = 0x097a; // raw fish steak

// Everything a fisher hauls in: plain fish, the raw steak a fish carves into, and the High Seas fish
// (Fish.cs BaseHighseasFish), which no shop buys whole but each carves into four steaks.
export const fish: ReadonlySet<number> = new Set([
  0x09cc,
  0x09cd,
  0x09ce,
  0x09cf,
  0x097a, // raw fish steak
  0x4302,
  0x4303,
  0x4304,
  0x4305,
  0x4306,
  0x4307,
  0x44c3,
  0x44c4,
  0x44c5,
  0x44c6
]);

// Cutting blades: daggers (both facings), the butcher knife and the skinning knife.
export const blades: ReadonlySet<number> = new Set([0x0f51, 0x0f52, 0x13f6, 0x0ec4]);
