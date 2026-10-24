import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

import { distance } from './navigation';

// The housing districts' lots (catalogs/house-lots.json, build-lots.ts) and who holds which, kept
// in the resident database (`houses`, `bad_lots`) so two residents never go for the same lot and a
// lot ServUO refused is not tried again. Each lot is the centre of a 7x7 classic house on a 9x13
// grid: ServUO wants five clear tiles in front and behind and one at the sides (HousePlacement.cs).
// Without the shared database (local runs, tests) the same tables live in memory.
export interface Lot {
  id: string;
  district: string;
  x: number;
  y: number;
  z: number;
}
export type HouseStatus = 'claimed' | 'placed' | 'elsewhere';
export interface HouseRecord {
  owner: string;
  lot: string;
  x: number;
  y: number;
  z: number;
  house?: string;
  status: HouseStatus;
  claimedAt: number;
  placedAt?: number;
  visitedAt?: number;
  storage?: number;
}

const catalog = JSON.parse(readFileSync(new URL('../catalogs/house-lots.json', import.meta.url), 'utf8')) as {
  schemaVersion: number;
  lots: Lot[];
};
if (catalog.schemaVersion !== 1) throw new Error('Unsupported house lot catalog');
let lots: readonly Lot[] = catalog.lots;
export const housingOpen = () => lots.length > 0;
// For tests: a lot list in place of the catalog.
export const useLots = (list: readonly Lot[]) => {
  lots = list;
};

const schema = `
  CREATE TABLE IF NOT EXISTS houses (
    owner TEXT PRIMARY KEY, lot TEXT NOT NULL UNIQUE, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    house TEXT, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, placed_at INTEGER, visited_at INTEGER, storage INTEGER
  );
  CREATE TABLE IF NOT EXISTS bad_lots (lot TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);`;
let db = new Database(':memory:');
db.exec(schema);
export const attachHousing = (database: Database) => {
  database.exec(schema);
  db = database;
};
export const housingDb = () => db;

interface Row {
  owner: string;
  lot: string;
  x: number;
  y: number;
  z: number;
  house: string | null;
  status: HouseStatus;
  claimed_at: number;
  placed_at: number | null;
  visited_at: number | null;
  storage: number | null;
}
const record = (row: Row): HouseRecord => ({
  owner: row.owner,
  lot: row.lot,
  x: row.x,
  y: row.y,
  z: row.z,
  house: row.house ?? undefined,
  status: row.status,
  claimedAt: row.claimed_at,
  placedAt: row.placed_at ?? undefined,
  visitedAt: row.visited_at ?? undefined,
  storage: row.storage ?? undefined
});

export function houseOf(owner: string): HouseRecord | undefined {
  const row = db.query<Row, [string]>('SELECT * FROM houses WHERE owner = ?').get(owner);
  return row ? record(row) : undefined;
}

// The resident's claim, or the free lot nearest `near` (its home bank), claimed now. A claim
// left unused for a day lapses, so a resident that never got there frees its lot.
export function claimLot(owner: string, near: { x: number; y: number }): HouseRecord | undefined {
  const held = houseOf(owner);
  if (held) return held;
  db.run("DELETE FROM houses WHERE status = 'claimed' AND claimed_at < ?", [Date.now() - 24 * 3_600_000]);
  const taken = new Set(
    [
      ...db.query<{ lot: string }, []>('SELECT lot FROM houses').all(),
      ...db.query<{ lot: string }, []>('SELECT lot FROM bad_lots').all()
    ].map((r) => r.lot)
  );
  const lot = lots
    .filter((l) => !taken.has(l.id))
    .sort((a, b) => distance(near, a) - distance(near, b) || a.id.localeCompare(b.id))[0];
  if (!lot) return undefined;
  db.run("INSERT INTO houses (owner, lot, x, y, z, status, claimed_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?)", [
    owner,
    lot.id,
    lot.x,
    lot.y,
    lot.z,
    Date.now()
  ]);
  return houseOf(owner);
}

export function updateHouse(owner: string, fields: Partial<Omit<HouseRecord, 'owner' | 'lot'>>) {
  const columns: Record<string, string> = {
    house: 'house',
    status: 'status',
    placedAt: 'placed_at',
    visitedAt: 'visited_at',
    storage: 'storage',
    x: 'x',
    y: 'y',
    z: 'z'
  };
  const entries = Object.entries(fields).filter(([key]) => columns[key]);
  if (!entries.length) return;
  db.run(`UPDATE houses SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE owner = ?`, [
    ...entries.map(([, value]) => (value === undefined ? null : (value as string | number))),
    owner
  ]);
}

// ServUO refused the lot (blocked, bad terrain): nobody tries it again, and the claim is dropped.
export function refuseLot(owner: string, lot: string, reason: string) {
  db.run('INSERT OR REPLACE INTO bad_lots (lot, reason, at) VALUES (?, ?, ?)', [lot, reason, Date.now()]);
  db.run("DELETE FROM houses WHERE owner = ? AND status = 'claimed'", [owner]);
}

export const dropClaim = (owner: string) =>
  db.run("DELETE FROM houses WHERE owner = ? AND status = 'claimed'", [owner]);

export function lotCounts() {
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    lots: lots.length,
    placed: count("SELECT COUNT(*) AS n FROM houses WHERE status = 'placed'"),
    claimed: count("SELECT COUNT(*) AS n FROM houses WHERE status = 'claimed'"),
    refused: count('SELECT COUNT(*) AS n FROM bad_lots')
  };
}
