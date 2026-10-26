import { arrow, bolt } from '@gemwright/common/items';

import type { PlayerSession } from './protocol/session';

export interface RangedWeapon {
  name: string;
  ammo: number;
  range: number;
  seconds: number;
}

// ServUO pub57 BaseRanged and the five weapon classes, including both facings.
const definitions: [number[], RangedWeapon][] = [
  [[0x13b1, 0x13b2], { name: 'bow', ammo: arrow, range: 10, seconds: 4.25 }],
  [[0x26c2, 0x26cc], { name: 'composite bow', ammo: arrow, range: 10, seconds: 4 }],
  [[0x0f4f, 0x0f50], { name: 'crossbow', ammo: bolt, range: 8, seconds: 4.5 }],
  [[0x13fc, 0x13fd], { name: 'heavy crossbow', ammo: bolt, range: 8, seconds: 5 }],
  [[0x26c3, 0x26cd], { name: 'repeating crossbow', ammo: bolt, range: 7, seconds: 2.75 }]
];
const profiles = new Map(definitions.flatMap(([ids, profile]) => ids.map((id) => [id, profile] as const)));
export const rangedGraphics: ReadonlySet<number> = new Set(profiles.keys());
export const rangedWeapon = (graphic: number | undefined) =>
  graphic === undefined ? undefined : profiles.get(graphic);

export function equippedRanged(session: PlayerSession) {
  return session.world
    .childrenOf(session.world.serial ?? -1)
    .find((item) => (item.layer === 1 || item.layer === 2) && profiles.has(item.graphic));
}

// An unmodified ML swing estimate; actual damage/ammunition feedback remains authoritative.
export function shootingWindow(weapon: RangedWeapon, stamina: number): number {
  return 1000 + Math.max(5, Math.floor(weapon.seconds * 4 - Math.floor(stamina / 30))) * 250;
}
