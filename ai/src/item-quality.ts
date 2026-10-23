import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// What an item is worth beyond its kind, read from its ordinary property list (0xD6), the tooltip a
// player sees on hover. Clilocs from the pinned ServUO Item, BaseWeapon and BaseArmor lists.
//   artifact     artifact rarity (1061078): never sold to a shop, kept or traded
//   blessed      1038021: kept
//   magic        AOS attributes: kept, worn or traded, never sold to a shop at base price
//   exceptional  1060636: a crafter's best work, traded to residents rather than sold to a shop
//   normal       everything else: fine to sell to a shop
// `unknown` means the property list has not been seen yet (see `learnQuality`).
export type Quality = 'artifact' | 'blessed' | 'magic' | 'exceptional' | 'normal' | 'unknown';

// AOS magic attribute clilocs. Elemental damage split (1060403-1060407) and base resists
// (1060445-1060449) appear on every ordinary item.
export const magicProperty = (cliloc: number) =>
  (cliloc >= 1060400 && cliloc <= 1060444 && (cliloc < 1060403 || cliloc > 1060407)) ||
  cliloc === 1060450 ||
  (cliloc >= 1060482 && cliloc <= 1060486);

export function quality(item: Entity): Quality {
  const properties = item.properties;
  if (!properties) return 'unknown';
  const has = (cliloc: number) => properties.some((entry) => entry.cliloc === cliloc);
  if (has(1061078)) return 'artifact';
  if (has(1038021)) return 'blessed';
  if (properties.some((entry) => magicProperty(entry.cliloc))) return 'magic';
  if (has(1060636)) return 'exceptional';
  return 'normal';
}

// Only plain goods go to a shop: an exceptional, magic, blessed or artifact piece is worth more
// than the shop's base price. An item whose properties are unknown is not sold until they are.
export const shopSafe = (item: Entity) => quality(item) === 'normal';

// Asks for the property lists not yet seen, as hovering over each would.
export async function learnQuality(session: PlayerSession, items: Entity[]) {
  for (const item of items.filter((i) => !i.properties).slice(0, 40))
    await session.inspectProperties(item.serial).catch(() => {});
}
