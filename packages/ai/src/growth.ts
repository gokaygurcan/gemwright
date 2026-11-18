import { skillNames } from '@gemwright/common/game/skills';
import type { PlayerSession } from '@gemwright/network/session';

import type { Mind } from './mind';
import type { Sheet } from './self';

type Stat = 0 | 1 | 2;
const STR: Stat = 0;
const DEX: Stat = 1;
const INT: Stat = 2;

// Each skill's primary and secondary stat, by skill id (ServUO Server/Skills.cs SkillInfo table):
// the stats using it trains.
const trains: readonly (readonly [Stat, Stat])[] = [
  [INT, DEX], // Alchemy
  [INT, STR], // Anatomy
  [INT, STR], // Animal Lore
  [INT, DEX], // Item Identification
  [INT, STR], // Arms Lore
  [DEX, STR], // Parrying
  [DEX, INT], // Begging
  [STR, DEX], // Blacksmithy
  [DEX, STR], // Bowcraft/Fletching
  [INT, DEX], // Peacemaking
  [DEX, INT], // Camping
  [STR, DEX], // Carpentry
  [INT, DEX], // Cartography
  [INT, DEX], // Cooking
  [INT, DEX], // Detecting Hidden
  [DEX, INT], // Discordance
  [INT, STR], // Evaluating Intelligence
  [INT, DEX], // Healing
  [DEX, STR], // Fishing
  [INT, DEX], // Forensic Evaluation
  [INT, DEX], // Herding
  [DEX, INT], // Hiding
  [INT, DEX], // Provocation
  [INT, DEX], // Inscription
  [DEX, INT], // Lockpicking
  [INT, STR], // Magery
  [STR, DEX], // Resisting Spells
  [STR, DEX], // Tactics
  [DEX, INT], // Snooping
  [DEX, INT], // Musicianship
  [INT, DEX], // Poisoning
  [DEX, STR], // Archery
  [INT, STR], // Spirit Speak
  [DEX, INT], // Stealing
  [DEX, INT], // Tailoring
  [STR, INT], // Animal Taming
  [INT, STR], // Taste Identification
  [DEX, INT], // Tinkering
  [INT, DEX], // Tracking
  [INT, DEX], // Veterinary
  [STR, DEX], // Swordsmanship
  [STR, DEX], // Mace Fighting
  [DEX, STR], // Fencing
  [STR, DEX], // Wrestling
  [STR, DEX], // Lumberjacking
  [STR, DEX], // Mining
  [INT, STR], // Meditation
  [DEX, INT], // Stealth
  [DEX, INT], // Remove Trap
  [INT, STR], // Necromancy
  [DEX, INT], // Focus
  [STR, INT], // Chivalry
  [STR, INT], // Bushido
  [DEX, INT], // Ninjitsu
  [INT, STR], // Spellweaving
  [STR, INT], // Mysticism
  [INT, STR], // Imbuing
  [DEX, STR] // Throwing
];
const byName = new Map(skillNames.map((name, id) => [name, trains[id]]));

// What its stats should come to for its trade: each stat weighed by the trade's skills (primary
// twice, secondary once), shared out of the total stat cap above the floor of 10 each, none over its
// own cap. With no trade, as they are.
export function statTargets(
  trade: readonly string[],
  current: readonly number[],
  caps: { stats: number; stat: readonly number[] }
): number[] {
  const weights = [0, 0, 0];
  for (const skill of trade) {
    const [primary, secondary] = byName.get(skill) ?? [];
    if (primary !== undefined) weights[primary] = (weights[primary] ?? 0) + 2;
    if (secondary !== undefined) weights[secondary] = (weights[secondary] ?? 0) + 1;
  }
  if (!weights.some(Boolean)) return [...current];
  const target = [10, 10, 10];
  let left = caps.stats - 30;
  const open = new Set([0, 1, 2]);
  while (left > 1e-9 && open.size) {
    const weight = [...open].reduce((sum, i) => sum + (weights[i] ?? 0), 0);
    if (!weight) break;
    let used = 0;
    for (const i of [...open]) {
      const share = (left * (weights[i] ?? 0)) / weight;
      const room = (caps.stat[i] ?? 125) - (target[i] ?? 10);
      const given = Math.min(share, room);
      target[i] = (target[i] ?? 10) + given;
      used += given;
      if (given >= room) open.delete(i);
    }
    left -= used;
    if (used < 1e-9) break;
  }
  return target.map(Math.round);
}

// ServUO StatLockType: Up 0, Down 1, Locked 2 (Mobile.cs). Below where its trade wants a stat it
// may rise, above it may fall, at it, it holds.
export const statLocks = (current: readonly number[], target: readonly number[]) =>
  current.map((value, i) => (value < (target[i] ?? value) ? 0 : value > (target[i] ?? value) ? 1 : 2));

// How it grows: its skills' base together against the shard's total cap, those that rose in the
// last hour and by how much, and which are set to rise, fall or hold.
export function growth(
  skills: ReadonlyMap<string, Sheet>,
  gains: readonly { skill: string; at: number; delta: number }[],
  cap: number,
  now: number
) {
  let total = 0;
  const locks: Record<'up' | 'down' | 'locked', string[]> = { up: [], down: [], locked: [] };
  for (const [name, sheet] of skills) {
    total += sheet.base;
    if (sheet.base > 0 || sheet.lock !== 0) locks[(['up', 'down', 'locked'] as const)[sheet.lock] ?? 'up'].push(name);
  }
  const rose = new Map<string, number>();
  for (const gain of gains)
    if (now - gain.at < 3_600_000 && gain.delta > 0) rose.set(gain.skill, (rose.get(gain.skill) ?? 0) + gain.delta);
  return {
    total: Math.round(total * 10) / 10,
    cap,
    room: Math.round((cap - total) * 10) / 10,
    rising: [...rose]
      .sort((a, b) => b[1] - a[1])
      .map(([skill, gained]) => ({ skill, gained: Math.round(gained * 10) / 10 })),
    locks
  };
}

// Its stats set toward what its trade wants, as a player sets the arrows on its status window: each
// lock changed once, then left to the shard to show (0xBF.19).
export function keepStatLocks(
  mind: Mind,
  session: PlayerSession,
  sent: (number | undefined)[],
  record: (kind: string, data: object) => void
) {
  const stats = mind.self.stats;
  const caps = mind.self.caps;
  const locks = mind.self.statLocks;
  if (!stats || !caps || !locks || !mind.tradeSkills.length) return;
  const now = [stats.strength, stats.dexterity, stats.intelligence];
  statLocks(now, statTargets(mind.tradeSkills, now, caps)).forEach((lock, stat) => {
    if (locks[stat] === lock || sent[stat] === lock) return;
    sent[stat] = lock;
    session.setLock('stat', stat, lock);
    record('locks-set', { stat: ['strength', 'dexterity', 'intelligence'][stat], lock });
  });
}
