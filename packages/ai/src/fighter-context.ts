import { bandage, gold, healPotion } from '@gemwright/common/items';

import type { CharacterTemplate } from './config';
import { type Landmark, pickLocation, type ServiceType, serviceLocation, serviceLocations } from './locations';
import type { createNavigator } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position, WorldView } from './protocol/world';
import { rangedGraphics, rangedWeapon } from './ranged-weapons';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';
import { reachableFrom } from './unreachable';

export { bandage, healPotion };
export const curePotion = 0x0f07;
export const graveyard = serviceLocation('Britain', 'graveyard');
// A fighter's home town: its bank is the town point, and every service comes from that city, falling
// back to Britain's when the city has none (world.json decides where fighters live).
export function homeOf(city: string, position?: () => { x: number; y: number }) {
  // Landmarks that proved unreachable from here are skipped; when none of the city's remain,
  // Britain's are used.
  const usable = (list: readonly Landmark[]) => (position ? list.filter((l) => reachableFrom(l, position())) : list);
  const all = (service: ServiceType) => {
    const own = usable(serviceLocations(city, service));
    return own.length ? own : usable(serviceLocations('Britain', service));
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
    town: bank ? { x: bank.x, y: bank.y } : { x: 1430, y: 1555 },
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

import { GHOST_BODIES } from '@gemwright/common/bodies';

// Recognised graveyard undead bodies; per-type risk lives in fighter-prey.ts.
import { prey } from './fighter-prey';

export { prey };
export const valuable = (graphic: number) =>
  graphic === gold ||
  (graphic >= 0xf10 && graphic <= 0xf30) ||
  (graphic >= 0x144e && graphic <= 0x1457) ||
  (graphic >= 0x1b72 && graphic <= 0x1b7b) ||
  Object.values(families).some((ids) => ids.includes(graphic)) ||
  // Arrows and bolts: AOS puts missed ammunition in the target's pack, so archers recover it.
  graphic === 0x0f3f ||
  graphic === 0x1bfb ||
  // Spell scrolls: mages buy them back, and casters add new ones to their spellbook.
  (graphic >= 0x1f2d && graphic <= 0x1f6c);

export class Died extends Error {}
export class Retreat extends Error {}

// Weapon families by combat skill (ServUO item IDs); a fighter only equips and buys its own family.
const families: Record<string, number[]> = {
  Swordsmanship: [0x13fe, 0x13ff, 0x0f5e, 0x0f5f, 0x13b5, 0x13b6, 0x0f60, 0x0f61],
  // Kryss, spear, short spear, war fork, dagger.
  Fencing: [0x1400, 0x1401, 0x0f62, 0x0f63, 0x1402, 0x1403, 0x1404, 0x1405, 0x0f51, 0x0f52],
  // Club, mace, war mace, war hammer, hammer pick, maul.
  'Mace Fighting': [0x13b3, 0x13b4, 0x0f5c, 0x0f5d, 0x1406, 0x1407, 0x1438, 0x1439, 0x143c, 0x143d, 0x143a, 0x143b],
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
export const weaponsFor = (template: CharacterTemplate) => sets.get(weaponSkill(template)) ?? new Set<number>();
export const arrow = 0x0f3f;
export const bolt = 0x1bfb;
// Ammunition a ranged weapon consumes (BaseRanged.AmmoType): crossbows use bolts.
export const ammoFor = (weapon: number | undefined) => rangedWeapon(weapon)?.ammo;

const passiveBodies = new Set([
  0x5, 0x6, 0xc8, 0xc9, 0xcb, 0xcc, 0xcd, 0xcf, 0xd0, 0xd1, 0xd7, 0xd8, 0xd9, 0xdf, 0xe2, 0xe4, 0xe7
]);

// Skips opponents this session could not legally reach; serials are session-scoped observations.
export const huntable = (mobile: Entity, unreachable: Set<number>) =>
  prey.has(mobile.graphic) && [3, 4, 5, 6].includes(mobile.notoriety ?? 0) && !unreachable.has(mobile.serial);

export function observedThreat(mobile: Entity, combatant: number | null = null): boolean {
  if (mobile.kind !== 'mobile' || ![3, 4, 5, 6].includes(mobile.notoriety ?? 0)) return false;
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
