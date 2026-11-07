import {
  bandage,
  boneArmor,
  gargishWeapons,
  gems,
  gold,
  healPotion,
  shields,
  weapons
} from '@gemwright/common/game/items';
import { bodiesOf, spellScrollGraphics } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity, Position, WorldView } from '@gemwright/network/world';

import { withinReach } from './areas';
import type { CharacterTemplate } from './config';
import { type Landmark, pickLocation, type ServiceType, serviceLocations } from './locations';
import { monsters } from './monster-reference';
import type { createNavigator } from './navigation';
import { rangedGraphics, rangedWeapon } from './ranged-weapons';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';
import { reachableFrom } from './unreachable';

export { bandage, healPotion };
// A fighter's home town: its bank is the town point, and every service comes from that city, falling
// back to Britain's when the city has none (world.json decides where fighters live).
export function homeOf(city: string, position?: () => { x: number; y: number }) {
  // Landmarks that proved unreachable from here are tried last.
  const usable = (list: readonly Landmark[]) =>
    position ? list.filter((l) => reachableFrom(l, position()) && withinReach(position(), l)) : list;
  // A town's own landmarks stay its own even when none proved reachable from where it stands now
  // (the other half of Jhelom, across a teleporter): only a town without one uses Britain's.
  const all = (service: ServiceType) => {
    const listed = serviceLocations(city, service);
    const own = usable(listed);
    return own.length ? own : listed.length ? [...listed] : usable(serviceLocations('Britain', service));
  };
  // When every landmark proved unreachable on foot from here (an island town), the catalogued one
  // is still returned: callers travel with travelNear, which takes a moongate.
  const one = (service: ServiceType) => {
    const own = serviceLocations(city, service);
    const point = all(service)[0] ?? own[0] ?? pickLocation('Britain', service);
    if (!point) throw new Error(`No ${service} landmark for ${city} or Britain`);
    return point;
  };
  const bank = all('banker')[0];
  return {
    city: serviceLocations(city, 'banker').length ? city : 'Britain',
    town: bank ?? serviceLocations('Britain', 'banker')[0] ?? position?.() ?? { x: 0, y: 0 },
    get banks() {
      return all('banker');
    },
    get shops() {
      return [...all('healer'), ...all('alchemist'), ...all('tailor')];
    },
    all,
    one
  };
}
export type Home = ReturnType<typeof homeOf>;
export const ghosts = GHOST_BODIES;

import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { arrow as arrowGraphic, crossbowBolt } from '@gemwright/common/game/items';
import { hostileNotoriety } from '@gemwright/network/opcodes';

// Recognised graveyard undead bodies; per-type risk lives in fighter-prey.ts.
import { prey } from './fighter-prey';

export { prey };
export const valuable = (graphic: number) =>
  graphic === gold ||
  gems.has(graphic) ||
  boneArmor.has(graphic) ||
  shields.has(graphic) ||
  Object.values(families).some((ids) => ids.includes(graphic)) ||
  // Arrows and bolts: AOS puts missed ammunition in the target's pack, so archers recover it.
  graphic === arrowGraphic ||
  graphic === crossbowBolt ||
  // Spell scrolls: mages buy them back, and casters add new ones to their spellbook.
  spellScrollGraphics.has(graphic);

export class Died extends Error {}
export class Retreat extends Error {}
// Attacked on the way by something it can fight: it turns and fights (fighter.ts), as a player would.
export class Ambushed extends Error {
  constructor(readonly attacker: Entity) {
    super('Attacked on the way; fighting back');
  }
}

// Weapon families by combat skill (@gemwright/common/game/items); a fighter only equips and buys its own
// family. Gargoyles wield only gargish weapons, listed with each family.
const families: Record<string, number[]> = {
  Swordsmanship: [...weapons.Swordsmanship, ...gargishWeapons.Swordsmanship],
  Fencing: [...weapons.Fencing, ...gargishWeapons.Fencing],
  'Mace Fighting': [...weapons['Mace Fighting'], ...gargishWeapons['Mace Fighting']],
  // Bow, crossbow, heavy crossbow.
  Archery: [...rangedGraphics]
};
// Archetypes without a weapon family (mages, bards, tamers, thieves) fight unarmed: Wrestling.
export const weaponSkill = (template: CharacterTemplate) =>
  template.archetype
    ? ([...template.archetype.primarySkills, ...template.archetype.supportingSkills].find((skill) => families[skill]) ??
      'Wrestling')
    : 'Swordsmanship';
const sets = new Map(Object.entries(families).map(([skill, ids]) => [skill, new Set(ids)]));
// Gargoyles wield only gargish weapons and the others none of them (ServUO race requirements): a
// human weapon bought for a gargoyle is refused and bought again, eight times in twenty minutes.
const gargish = new Set(Object.values(gargishWeapons).flat());
export const wieldableBy = (gargoyle: boolean, graphic: number) => gargish.has(graphic) === gargoyle;
// Every melee weapon of any family: a stand-in when a fighter has none of its own (fighter-equipment.ts).
export const meleeWeapons = new Set(
  ['Swordsmanship', 'Fencing', 'Mace Fighting'].flatMap((skill) => families[skill] ?? [])
);
// The skill a weapon is used with (its family), Wrestling for none.
export const familyOf = (graphic: number | undefined) =>
  graphic === undefined ? 'Wrestling' : ([...sets].find(([, ids]) => ids.has(graphic))?.[0] ?? 'Wrestling');
export const weaponsFor = (template: CharacterTemplate) => sets.get(weaponSkill(template)) ?? new Set<number>();
// Ammunition a ranged weapon consumes (BaseRanged.AmmoType): crossbows use bolts.
export const ammoFor = (weapon: number | undefined) => rangedWeapon(weapon)?.ammo;

// Bodies some creature that never attacks on sight wears (the ServUO monster catalog).
const passiveBodies = new Set(monsters.filter((m) => !m.aggressive).flatMap((m) => [...m.bodies, ...bodiesOf(m.type)]));

// Skips opponents this session could not legally reach; serials are session-scoped observations.
export const huntable = (mobile: Entity, unreachable: Set<number>) =>
  prey.has(mobile.graphic) && hostileNotoriety.includes(mobile.notoriety ?? 0) && !unreachable.has(mobile.serial);

export function observedThreat(mobile: Entity, combatant: number | null = null): boolean {
  if (mobile.kind !== 'mobile' || !hostileNotoriety.includes(mobile.notoriety ?? 0)) return false;
  if (mobile.serial === combatant || [4, 5, 6].includes(mobile.notoriety ?? 0)) return true;
  return !passiveBodies.has(mobile.graphic);
}

export interface FighterContext {
  session: PlayerSession;
  home: Home;
  template: CharacterTemplate;
  terrain: Terrain;
  checkpoint: Checkpoint;
  trip: NonNullable<Checkpoint['hunting']>;
  serial: number;
  deadline: number;
  backpack: () => number;
  refreshBackpack: () => Promise<void>;
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  dead: () => boolean;
  contents: (container?: number) => Entity[];
  count: (graphic: number) => number;
  nearby: () => Entity[];
  open: (container: number) => Promise<void>;
  navigate: ReturnType<typeof createNavigator>;
  escapeNavigate: ReturnType<typeof createNavigator>;
  check: () => void;
  phase: (value: string, text: string) => void;
  log: (text: string) => void;
  persist: () => void;
  state: {
    inCombat: boolean;
    recovering: boolean;
    recoveringCorpse: boolean;
    abandonedBandageCursor: boolean;
    fightingSerial: number | null;
  };
  stats: Record<
    | 'kills'
    | 'looted'
    | 'sold'
    | 'bankedGold'
    | 'bankedItems'
    | 'retreats'
    | 'resurrections'
    | 'tacticalBreaks'
    | 'reengagements'
    | 'burstEscapes'
    | 'completedBandages'
    | 'failedBandages'
    | 'recoveredItems'
    | 'abandonedCorpses'
    | 'replacementWeapons',
    number
  >;
}

// A fighter's run counters, all at zero.
export const newFighterStats = (): FighterContext['stats'] => ({
  kills: 0,
  looted: 0,
  sold: 0,
  bankedGold: 0,
  bankedItems: 0,
  retreats: 0,
  resurrections: 0,
  tacticalBreaks: 0,
  reengagements: 0,
  burstEscapes: 0,
  completedBandages: 0,
  failedBandages: 0,
  recoveredItems: 0,
  abandonedCorpses: 0,
  replacementWeapons: 0
});
