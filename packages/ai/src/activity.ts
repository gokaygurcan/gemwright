import type { Database } from 'bun:sqlite';

import type { PlayerSession } from '@gemwright/network/session';

import { mindOf } from './mind-sizes';

// Running activity for population reports: every five minutes, the steps each session walked since
// the last look, one position, gold and bank sample per resident, and how the process itself is doing,
// in a single transaction. Nothing here talks to the shard.

// Event-loop lag since the last save (run-population.ts measures it), for the population metrics.
export const loopLag = { max: 0, stalls: 0 };

const counted = (session: PlayerSession) => {
  const moves = session.movementCounts;
  return { steps: moves.walking + moves.running };
};

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

  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS population_metrics (
      at INTEGER NOT NULL, online INTEGER NOT NULL, rss_mb INTEGER NOT NULL, lag_max_ms INTEGER NOT NULL, stalls INTEGER NOT NULL
    )`);
  }

  // Takes a session's unsaved growth; called on every save and when a session is replaced or ends.
  collect(residentId: string, session: PlayerSession) {
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
        const bank = mindOf(session)?.bankGold ?? null;
        sample.run(id, at, session.world.map, position.x, position.y, null, session.world.status?.gold ?? null, bank);
      }
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
  }
}
