import type { Database } from 'bun:sqlite';

import { HUMAN_BODIES } from '@gemwright/common/bodies';

import { attachGuilds } from './guild-store';
import { attachHousing } from './house-lots';
import { attachInsight } from './player-insight';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';

// Running activity totals for population reports. Behaviors bump a counter on the session where
// the activity happens; the recorder saves the growth since its last look into per-resident totals
// every five minutes, with one position and wealth sample, in a single transaction. Nothing here
// talks to the shard.
const tallies = new WeakMap<PlayerSession, Record<string, number>>();

export function tally(session: PlayerSession, name: string, amount = 1) {
  const counts = tallies.get(session) ?? {};
  counts[name] = (counts[name] ?? 0) + amount;
  tallies.set(session, counts);
}

export function observedWorkCount(session: PlayerSession): number {
  const counts = tallies.get(session) ?? {};
  return ['mined', 'chopped', 'fished', 'crafted', 'kills'].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

// Every market deal a session attempted (market.ts), saved to the trade log with the totals.
export interface TradeEvent {
  role: 'seller' | 'buyer';
  partner: string;
  good: string;
  amount: number;
  price: number;
  market: string;
  done: boolean;
  // Why a failed deal failed (trade-deal.ts).
  reason?: string;
}
const trades = new WeakMap<PlayerSession, (TradeEvent & { at: number })[]>();
export function noteTrade(session: PlayerSession, event: TradeEvent) {
  const list = trades.get(session) ?? [];
  list.push({ ...event, at: Date.now() });
  trades.set(session, list);
}

// Event-loop lag since the last save (run-population.ts measures it), for the population metrics.
export const loopLag = { max: 0, stalls: 0 };

// Characters the population plays (store bindings and logged-in sessions); anyone else a resident
// meets, apart from NPC vendors, is a real player.
const residents = new Set<number>();
export const markResidents = (serials: Iterable<number>) => {
  for (const serial of serials) residents.add(serial);
};
export const isResident = (serial: number) => residents.has(serial);

// What residents notice about real players: market lines (good, amount, price), trade windows
// opened on a resident, and speech aimed at one (when and where, never the words). One event is
// heard by several residents, so `key` records it once.
export interface PlayerSignal {
  kind: 'market' | 'trade-attempt' | 'speech';
  serial: number;
  name: string;
  x: number;
  y: number;
  offer?: string;
  good?: string;
  amount?: number;
  price?: number;
}
let signals: (PlayerSignal & { at: number })[] = [];
const noted = new Set<string>();
export function notePlayer(session: PlayerSession, key: string, signal: Omit<PlayerSignal, 'x' | 'y'>) {
  const mobile = session.world.entities.get(signal.serial);
  // Players have human or elf bodies; speaking monsters (orcs, lizardmen) and vendors are not players.
  const human = !mobile || HUMAN_BODIES.has(mobile.graphic);
  if (residents.has(signal.serial) || mobile?.notoriety === 7 || !human || noted.has(key)) return;
  noted.add(key);
  if (noted.size > 5000) noted.delete(noted.values().next().value as string);
  const at = mobile?.position ?? session.world.position;
  signals.push({ ...signal, x: at?.x ?? 0, y: at?.y ?? 0, at: Date.now() });
}

// Everything a session has counted, steps included (from its movement acknowledgements).
function counted(session: PlayerSession): Record<string, number> {
  const moves = session.movementCounts;
  return { ...tallies.get(session), steps: moves.walking + moves.running };
}

const retentionMs = 30 * 24 * 3600_000;

export const activitySchema = `CREATE TABLE activity (
    resident_id TEXT PRIMARY KEY, totals_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE activity_samples (
    resident_id TEXT NOT NULL, at INTEGER NOT NULL, map INTEGER, x INTEGER, y INTEGER,
    phase TEXT, gold INTEGER, bank INTEGER
  );
  CREATE INDEX activity_samples_at ON activity_samples (at);`;

export class ActivityRecorder {
  // What each session had counted at the last save, so only growth is added.
  private readonly saved = new WeakMap<PlayerSession, Record<string, number>>();
  private readonly pending = new Map<string, Record<string, number>>();
  private pendingTrades: (TradeEvent & { at: number; residentId: string })[] = [];

  constructor(
    private readonly db: Database,
    private readonly checkpoint: (residentId: string) => Checkpoint | undefined
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS player_signals (
      at INTEGER NOT NULL, kind TEXT NOT NULL, serial INTEGER NOT NULL, name TEXT NOT NULL, x INTEGER, y INTEGER,
      offer TEXT, good TEXT, amount INTEGER, price INTEGER
    )`);
    attachInsight(db);
    attachHousing(db);
    attachGuilds(db);
    db.exec(`CREATE TABLE IF NOT EXISTS population_metrics (
      at INTEGER NOT NULL, online INTEGER NOT NULL, rss_mb INTEGER NOT NULL, lag_max_ms INTEGER NOT NULL, stalls INTEGER NOT NULL
    )`);
    // Added after the first trade logs were written; older rows have none.
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(trade_log)').all();
    if (columns.length && !columns.some((c) => c.name === 'reason'))
      db.exec('ALTER TABLE trade_log ADD COLUMN reason TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS trade_log (
      resident_id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, partner TEXT NOT NULL, good TEXT NOT NULL,
      amount INTEGER NOT NULL, price INTEGER NOT NULL, market TEXT NOT NULL, completed INTEGER NOT NULL, reason TEXT
    )`);
  }

  // Takes a session's unsaved growth; called on every save and when a session is replaced or ends.
  collect(residentId: string, session: PlayerSession) {
    const events = trades.get(session);
    if (events?.length) {
      this.pendingTrades.push(...events.map((event) => ({ ...event, residentId })));
      trades.delete(session);
    }
    const now = counted(session);
    const before = this.saved.get(session) ?? {};
    const into = this.pending.get(residentId) ?? {};
    for (const [name, value] of Object.entries(now)) {
      const grown = value - (before[name] ?? 0);
      if (grown > 0) into[name] = (into[name] ?? 0) + grown;
    }
    this.saved.set(session, now);
    this.pending.set(residentId, into);
  }

  save(sessions: Map<string, PlayerSession>, at = Date.now()) {
    for (const [id, session] of sessions) this.collect(id, session);
    const read = this.db.query<{ totals_json: string }, [string]>(
      'SELECT totals_json FROM activity WHERE resident_id = ?'
    );
    const write = this.db.query(
      `INSERT INTO activity (resident_id, totals_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (resident_id) DO UPDATE SET totals_json = excluded.totals_json, updated_at = excluded.updated_at`
    );
    const sample = this.db.query(
      'INSERT INTO activity_samples (resident_id, at, map, x, y, phase, gold, bank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      for (const [id, grown] of this.pending) {
        if (!Object.keys(grown).length) continue;
        const totals = JSON.parse(read.get(id)?.totals_json ?? '{}') as Record<string, number>;
        for (const [name, value] of Object.entries(grown)) totals[name] = (totals[name] ?? 0) + value;
        write.run(id, JSON.stringify(totals), at);
      }
      for (const [id, session] of sessions) {
        const position = session.world.position;
        if (session.phase !== 'ready' || !position) continue;
        const checkpoint = this.checkpoint(id);
        sample.run(
          id,
          at,
          session.world.map,
          position.x,
          position.y,
          checkpoint?.life?.phase ?? null,
          session.world.status?.gold ?? null,
          checkpoint?.funds?.bank ?? null
        );
      }
      const log = this.db.query(
        'INSERT INTO trade_log (resident_id, at, role, partner, good, amount, price, market, completed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const signal = this.db.query(
        'INSERT INTO player_signals (at, kind, serial, name, x, y, offer, good, amount, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of signals)
        signal.run(
          p.at,
          p.kind,
          p.serial,
          p.name,
          p.x,
          p.y,
          p.offer ?? null,
          p.good ?? null,
          p.amount ?? null,
          p.price ?? null
        );
      for (const t of this.pendingTrades)
        log.run(
          t.residentId,
          t.at,
          t.role,
          t.partner,
          t.good,
          t.amount,
          t.price,
          t.market,
          t.done ? 1 : 0,
          t.reason ?? null
        );
      // How the process itself is doing, once a save: residents online, memory, worst event-loop lag.
      const online = [...sessions.values()].filter((s) => s.phase === 'ready').length;
      this.db
        .query('INSERT INTO population_metrics (at, online, rss_mb, lag_max_ms, stalls) VALUES (?, ?, ?, ?, ?)')
        .run(at, online, Math.round(process.memoryUsage().rss / 1_048_576), Math.round(loopLag.max), loopLag.stalls);
      loopLag.max = 0;
      loopLag.stalls = 0;
      this.db.query('DELETE FROM activity_samples WHERE at < ?').run(at - retentionMs);
      this.db.query('DELETE FROM population_metrics WHERE at < ?').run(at - retentionMs);
    })();
    this.pending.clear();
    this.pendingTrades = [];
    signals = [];
  }
}
