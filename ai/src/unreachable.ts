// Destinations that proved unreachable, shared by every resident in the process. Reachability
// depends on where a walk starts (an island bank is reachable from the island, not from the shore
// across the water), so each entry is keyed by the destination and the 128-tile area the walk began
// in, and expires after half an hour.
const until = new Map<string, number>();
const HOLD_MS = 30 * 60_000;
const key = (goal: { x: number; y: number }, from: { x: number; y: number }) =>
  `${goal.x},${goal.y}|${from.x >> 7},${from.y >> 7}`;

export function markUnreachable(goal: { x: number; y: number }, from: { x: number; y: number }) {
  if (until.size > 5000) until.clear();
  until.set(key(goal, from), Date.now() + HOLD_MS);
}

export const reachableFrom = (goal: { x: number; y: number }, from: { x: number; y: number }) =>
  (until.get(key(goal, from)) ?? 0) < Date.now();
