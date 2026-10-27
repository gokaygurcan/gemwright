import { distance } from './navigation';

// Where the population is, for spreading it out: no crowd on one screen, nobody alone across the
// map. Each resident reports its position whenever it changes phase (relationships.ts); choices
// of a destination (a leisure spot, a town to visit, a cemetery, a dungeon) weigh how many
// residents are already there. Like the allocator that gives residents their homes, this is the
// population's arrangement, not any one character's knowledge; up close, residents still judge by
// what they observe.
const where = new Map<number, { x: number; y: number; at: number }>();
const STALE_MS = 10 * 60_000;

export function reportPosition(serial: number, at: { x: number; y: number }) {
  where.set(serial, { x: at.x, y: at.y, at: Date.now() });
}

// Residents seen within `radius` of a point in the last ten minutes, other than `self`.
export function residentsNear(point: { x: number; y: number }, radius: number, self?: number): number {
  const now = Date.now();
  let count = 0;
  for (const [serial, seen] of where) {
    if (now - seen.at > STALE_MS) where.delete(serial);
    else if (serial !== self && distance(seen, point) <= radius) count++;
  }
  return count;
}

// Residents seen in the last ten minutes whose position satisfies `inside` (a dungeon's bounds).
export function residentsWhere(inside: (at: { x: number; y: number }) => boolean): number {
  const now = Date.now();
  let count = 0;
  for (const seen of where.values()) if (now - seen.at <= STALE_MS && inside(seen)) count++;
  return count;
}

// A destination's appeal by how many are there: best with company (`ideal` residents), less so
// alone, falling away as it fills beyond `crowd`.
export function crowdFactor(present: number, ideal = 3, crowd = 8): number {
  if (present < ideal) return 0.6 + (0.4 * present) / ideal;
  if (present <= crowd) return 1;
  return Math.max(0.1, 1 - (present - crowd) * 0.12);
}

// A random pick in proportion to `weight`.
export function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, random = Math.random): T | undefined {
  const weights = items.map(weight);
  let roll = random() * weights.reduce((sum, w) => sum + w, 0);
  for (const [i, item] of items.entries()) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return item;
  }
  return items.at(-1);
}

// Serials of residents seen within `radius` of a point in the last ten minutes (gossip.ts: who saw it).
export function residentsAround(point: { x: number; y: number }, radius: number): number[] {
  const now = Date.now();
  return [...where].filter(([, seen]) => now - seen.at <= STALE_MS && distance(seen, point) <= radius).map(([s]) => s);
}
