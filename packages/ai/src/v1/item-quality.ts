import { ItemProperty } from '@gemwright/common/game/items';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { checkpointOf } from './gm';

// What an item is beyond its kind, read from its ordinary property list (0xD6), the tooltip a player
// sees on hover. Independent facts, as ServUO keeps them (clilocs from the pinned Item and
// BaseWeapon/BaseArmor lists): a piece can be a cursed, insured greater artifact at once.
//   lootType     Item.AddLootTypeProperty: blessed 1038021, cursed 1049643, else regular. Newbied
//                shows nothing on the tooltip, so it reads as regular (a shop leaves it off its list).
//   insured      1061682
//   power        ItemPower 1151488-1151491 (minor-major) and 1152281-1152284 (reforged): magic;
//                1151492-1151495 (lesser-legendary artifact) or artifact rarity 1061078: artifact;
//                AOS magic attributes alone: magic; else none
//   exceptional  Quality.Exceptional 1060636; Low and Normal look the same on the tooltip
export interface ItemTraits {
  lootType: 'regular' | 'blessed' | 'cursed';
  insured: boolean;
  power: 'none' | 'magic' | 'artifact';
  exceptional: boolean;
}
const INSURED = 1061682;
const CURSED = 1049643;

// AOS magic attribute clilocs. Elemental damage split (1060403-1060407) and base resists
// (1060445-1060449) appear on every ordinary item.
export const magicProperty = (cliloc: number) =>
  (cliloc >= 1060400 && cliloc <= 1060444 && (cliloc < 1060403 || cliloc > 1060407)) ||
  cliloc === 1060450 ||
  (cliloc >= 1060482 && cliloc <= 1060486);

// undefined: the property list has not been seen yet (see learnQuality).
export function traits(item: Entity): ItemTraits | undefined {
  const properties = item.properties;
  if (!properties) return undefined;
  const has = (cliloc: number) => properties.some((entry) => entry.cliloc === cliloc);
  const within = (from: number, to: number) => properties.some((entry) => entry.cliloc >= from && entry.cliloc <= to);
  return {
    lootType: has(ItemProperty.blessed) ? 'blessed' : has(CURSED) ? 'cursed' : 'regular',
    insured: has(INSURED),
    power:
      has(ItemProperty.artifact) || within(1151492, 1151495)
        ? 'artifact'
        : within(1151488, 1151491) ||
            within(1152281, 1152284) ||
            properties.some((entry) => magicProperty(entry.cliloc))
          ? 'magic'
          : 'none',
    exceptional: has(ItemProperty.exceptional)
  };
}

// A shop may take it: a regular, uninsured piece with no item power (exceptional or not).
// Magic and artifact pieces included: no other buyer on the shard pays for them, and kept they only
// filled the bank. One worth wearing is put on first (inventory-use.ts).
export const shopTakes = (item: Entity) => {
  const t = traits(item);
  return !!t && t.lootType === 'regular' && !t.insured;
};
// Plain goods for a shop: what a shop takes, and not exceptional (a crafter's best is worth more).
export const shopSafe = (item: Entity) => shopTakes(item) && !traits(item)?.exceptional;

// Newbied never shows on the tooltip: a vendor whose trade buys the kind and still leaves a piece off
// its sell list (0x9E) is the only sign. Such pieces are kept on the checkpoint and never sold or
// put down. A piece a vendor did list is proven regular for this session.
const listed = new WeakMap<PlayerSession, Set<number>>();
export const knownNewbied = (session: PlayerSession, serial: number) =>
  !!checkpointOf(session)?.newbied?.includes(serial);
export function noteNewbied(session: PlayerSession, serials: readonly number[]) {
  const checkpoint = checkpointOf(session);
  if (!checkpoint || !serials.length) return;
  checkpoint.newbied = [...new Set([...(checkpoint.newbied ?? []), ...serials])].slice(-200);
}
export function noteListed(session: PlayerSession, serials: readonly number[]) {
  const seen = listed.get(session) ?? new Set<number>();
  listed.set(session, seen);
  for (const serial of serials) seen.add(serial);
}
export const provenRegular = (session: PlayerSession, serial: number) => !!listed.get(session)?.has(serial);

// Asks for the property lists not yet seen, as hovering over each would.
export async function learnQuality(session: PlayerSession, items: Entity[]) {
  for (const item of items.filter((i) => !i.properties).slice(0, 40))
    await session.inspectProperties(item.serial).catch(() => {});
}
