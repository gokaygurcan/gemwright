import { lasting } from './lasting';
import { tuning } from './tuning';

// The World layer says what may be somewhere (a spawner's vendor, healer, escort or animals; a
// ground's creatures), not what is there now: a wandering healer dies, a ground is picked clean. A
// resident that went to find it and did not keeps that for a while, and only for a while, because
// the spawner brings it back. A second miss soon after holds longer. One rule for every kind, per
// resident (as a player remembers what it saw) and across restarts (lasting.ts).
export type AbsentKind = keyof typeof tuning.absence.minutes;

const keyOf = (kind: AbsentKind, at: { x: number; y: number }, what = '') => `${kind}:${what}:${at.x},${at.y}`;

export function absence(me: number) {
  const table = lasting('absent', me);
  return {
    // Records a miss; returns how many minutes it is held.
    note(kind: AbsentKind, at: { x: number; y: number }, what = '') {
      const key = keyOf(kind, at, what);
      const again = table.active(`${key}|recent`);
      const minutes = tuning.absence.minutes[kind] * (again ? tuning.absence.repeatFactor : 1);
      table.set(key, Date.now() + minutes * 60_000);
      table.set(`${key}|recent`, Date.now() + 2 * minutes * 60_000);
      return minutes;
    },
    seen: (kind: AbsentKind, at: { x: number; y: number }, what = '') => table.active(keyOf(kind, at, what))
  };
}
