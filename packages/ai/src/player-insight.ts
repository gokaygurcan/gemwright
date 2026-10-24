import type { Database } from 'bun:sqlite';

import { distance } from './navigation';

// What the recorded player signals (activity.ts `player_signals`) say, for residents to follow:
// the going price of a good, what players ask for, and where they are heard. Each answer needs a
// minimum sample, is bounded, and is cached for ten minutes; with too little data it says nothing
// and residents keep their own rules.
let db: Database | undefined;
export const attachInsight = (database: Database) => {
  db = database;
};

const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string, read: (database: Database) => T): T | undefined {
  if (!db) return undefined;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value as T;
  let value: T | undefined;
  try {
    value = read(db);
  } catch {
    value = undefined;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

const WEEK = 7 * 24 * 3_600_000;

// The median unit price players named for a good this week, from at least five market lines.
export function playerUnitPrice(good: string): number | undefined {
  return cached(`price:${good}`, (database) => {
    const rows = database
      .query<{ unit: number }, [string, number]>(
        `SELECT CAST(price AS REAL) / amount AS unit FROM player_signals
         WHERE kind = 'market' AND good = ? AND price > 0 AND amount > 0 AND at > ? ORDER BY unit`
      )
      .all(good, Date.now() - WEEK);
    return rows.length >= 5 ? rows[Math.floor(rows.length / 2)]?.unit : undefined;
  });
}

// How often players asked to buy each good this week (three asks or more count).
export function playerDemand(): Map<string, number> {
  return (
    cached('demand', (database) => {
      const rows = database
        .query<{ good: string; n: number }, [number]>(
          `SELECT good, COUNT(*) AS n FROM player_signals
           WHERE kind = 'market' AND offer = 'buying' AND good IS NOT NULL AND at > ? GROUP BY good`
        )
        .all(Date.now() - WEEK);
      return new Map(rows.filter((r) => r.n >= 3).map((r) => [r.good, r.n]));
    }) ?? new Map()
  );
}

// A town's pull from players heard there in the last day: 1 (none) up to 2, from ten signals on.
export function playerPull(point: { x: number; y: number }): number {
  const spots =
    cached('spots', (database) =>
      database
        .query<{ x: number; y: number }, [number]>('SELECT x, y FROM player_signals WHERE at > ?')
        .all(Date.now() - 24 * 3_600_000)
    ) ?? [];
  const near = spots.filter((s) => distance(point, s) <= 60).length;
  return 1 + Math.min(1, near / 10);
}
