import { arrow, crossbowBolt, gargishWeapons, weapons } from '@gemwright/common/game/items';
import { rangedWeapons } from '@gemwright/common/game/rules';

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
export const rangedWeapon = (graphic: number | undefined) =>
  graphic === undefined ? undefined : profiles.get(graphic);

// An unmodified ML swing estimate; actual damage/ammunition feedback remains authoritative.
export function shootingWindow(weapon: RangedWeapon, stamina: number): number {
  return 1000 + Math.max(5, Math.floor(weapon.seconds * 4 - Math.floor(stamina / 30))) * 250;
}

// Weapon families by combat skill, gargish ones with each family.
const families = new Map<string, Set<number>>(
  Object.entries({
    Swordsmanship: [...weapons.Swordsmanship, ...gargishWeapons.Swordsmanship],
    Fencing: [...weapons.Fencing, ...gargishWeapons.Fencing],
    'Mace Fighting': [...weapons['Mace Fighting'], ...gargishWeapons['Mace Fighting']],
    Archery: [...profiles.keys()]
  }).map(([skill, ids]) => [skill, new Set(ids)])
);
export const meleeWeapons = new Set(
  ['Swordsmanship', 'Fencing', 'Mace Fighting'].flatMap((skill) => [...(families.get(skill) ?? [])])
);
// The skill a weapon is used with (its family), Wrestling for none.
export const familyOf = (graphic: number | undefined) =>
  graphic === undefined ? 'Wrestling' : ([...families].find(([, ids]) => ids.has(graphic))?.[0] ?? 'Wrestling');
