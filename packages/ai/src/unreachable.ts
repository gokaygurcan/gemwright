import type { HistoryEvent } from './history';

type Position = { x: number; y: number; z?: number; map?: number | null };
const failures = new Map<string, number>();
const key = (from: Position, goal: Position) =>
  `${from.map ?? 1}|${from.x >> 7},${from.y >> 7},${from.z ?? 0}|${goal.x},${goal.y}`;

export function learnRoute(event: HistoryEvent, scope = '') {
  if (event.kind !== 'route-failed') return;
  const data = event.data as { from: Position; goal: Position; until: number };
  if (!data.from || !data.goal || !Number.isFinite(data.until)) return;
  if (failures.size >= 20_000) for (const [name, until] of failures) if (until <= Date.now()) failures.delete(name);
  if (failures.size >= 20_000) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(`${scope}|${key(data.from, data.goal)}`, data.until);
}

export const reachable = (from: Position, goal: Position, now = Date.now(), scope = '') =>
  (failures.get(`${scope}|${key(from, goal)}`) ?? 0) <= now;
