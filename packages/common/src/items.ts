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
  0x13fb // large battle axe (alternate)
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
export const sewingKit = 0x0f9d;

// Supplies a fighter or mage runs out of.
export const bandage = 0x0e21;
export const healPotion = 0x0f0c; // greater heal potion
export const arrow = 0x0f3f;
export const bolt = 0x1bfb; // crossbow bolt
export const reagents = new Set([
  0x0f7a, // black pearl
  0x0f7b, // bloodmoss
  0x0f84, // garlic
  0x0f85, // ginseng
  0x0f86, // mandrake root
  0x0f88, // nightshade
  0x0f8c, // sulfurous ash
  0x0f8d // spider's silk
]);

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
