import { lasting } from './lasting';

// Destinations that proved unreachable, shared by every resident in the process. Reachability
// depends on where a walk starts (an island bank is reachable from the island, not from the shore
// across the water), so each entry is keyed by the destination and the 128-tile area the walk began
// in, and expires after two hours (ten minutes when monsters were in the way). They outlive a restart (lasting.ts).
const until = lasting('unreachable');
const HOLD_MS = 2 * 3_600_000;
const key = (goal: { x: number; y: number }, from: { x: number; y: number }) =>
  `${goal.x},${goal.y}|${from.x >> 7},${from.y >> 7}`;

export function markUnreachable(goal: { x: number; y: number }, from: { x: number; y: number }, hold = HOLD_MS) {
  until.set(key(goal, from), Date.now() + hold);
}

export const reachableFrom = (goal: { x: number; y: number }, from: { x: number; y: number }) =>
  !until.active(key(goal, from));
