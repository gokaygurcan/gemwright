import { arrow, crossbowBolt } from '@gemwright/common/game/items';
import { rangedWeapons } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

export interface RangedWeapon {
  name: string;
  ammo: number;
  range: number;
  seconds: number;
}

// ServUO BaseRanged weapons, both facings; a graphic shared by an artifact keeps its plain weapon's profile.
const ammunition: Record<string, number> = { Arrow: arrow, Bolt: crossbowBolt };
const profiles = new Map<number, RangedWeapon>();
for (const weapon of rangedWeapons().sort((a, b) => a.type.length - b.type.length))
  if (!profiles.has(weapon.graphic) && ammunition[weapon.ammo] !== undefined)
    profiles.set(weapon.graphic, {
      name: weapon.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
      ammo: ammunition[weapon.ammo] ?? arrow,
      range: weapon.range,
      seconds: weapon.seconds
    });
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
