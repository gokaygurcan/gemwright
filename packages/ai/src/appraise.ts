import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { itemName, type SelfImage, wornBy } from './self';
import type { Checkpoint } from './store';

// What a resident makes of another player from what anyone can see: the weapon in hand, the
// armour worn, a mount, the name's colour. Measured against itself (self.ts): stronger, a match or
// weaker; well-off or poor; dangerous or not; and so whether it would hunt beside them.
export interface Appraisal {
  at: string;
  weapon?: string;
  armorPieces: number;
  coverage: number;
  mounted: boolean;
  // Their gear's replacement cost, and a rough fighting strength from it, 0-1.
  worth: number;
  power: number;
  standing: 'stronger' | 'match' | 'weaker';
  wealth: 'well-off' | 'modest' | 'poor';
  dangerous: boolean;
  wouldHuntWith: boolean;
  opinion: string;
}

export function appraise(session: PlayerSession, other: Entity, me: SelfImage | undefined): Appraisal {
  const gear = wornBy(session, other.serial);
  // Skill is not visible; gear is how players size each other up.
  const power = Math.min(1, (gear.weapon ? 0.45 : 0.15) + 0.4 * gear.coverage + (gear.shield ? 0.05 : 0));
  const mine = me?.power ?? 0.5;
  const standing = power > mine + 0.15 ? 'stronger' : power < mine - 0.15 ? 'weaker' : 'match';
  const wealth = gear.value >= 1000 ? 'well-off' : gear.value >= 150 ? 'modest' : 'poor';
  // Grey (criminal) or red (murderer) names, as the client colours them.
  const dangerous = [4, 6].includes(other.notoriety ?? 0);
  const weapon = gear.weapon ? itemName(gear.weapon.graphic) : undefined;
  const wouldHuntWith = !dangerous && !!gear.weapon && standing !== 'weaker';
  const looks = [
    weapon ? `carries a ${weapon}` : 'carries no weapon',
    gear.armor.length ? `wears ${gear.armor.length} pieces of armour` : 'wears no armour',
    gear.mounted ? 'rides' : undefined
  ]
    .filter(Boolean)
    .join(', ');
  const opinion = `${looks}; ${dangerous ? 'not to be trusted' : `${standing === 'match' ? 'about my match' : `${standing} than me`}`}, ${wealth}`;
  return {
    at: new Date().toISOString(),
    weapon,
    armorPieces: gear.armor.length,
    coverage: Math.round(gear.coverage * 100) / 100,
    mounted: gear.mounted,
    worth: gear.value,
    power: Math.round(power * 100) / 100,
    standing,
    wealth,
    dangerous,
    wouldHuntWith,
    opinion
  };
}

// What it made of the people it met lately, for its decisions (decisions.ts).
export const peopleSeen = (checkpoint: Checkpoint) =>
  Object.entries(checkpoint.relationships)
    .filter(([, r]) => r.appraisal)
    .sort((a, b) => (b[1].lastSeen ?? '').localeCompare(a[1].lastSeen ?? ''))
    .slice(0, 5)
    .map(([name, r]) => ({ name, seen: r.seen, affinity: r.affinity, opinion: r.appraisal?.opinion }));
