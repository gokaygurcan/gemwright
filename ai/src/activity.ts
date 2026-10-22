import type { Database } from 'bun:sqlite';

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

  constructor(
    private readonly db: Database,
    private readonly checkpoint: (residentId: string) => Checkpoint | undefined
  ) {}

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
      this.db.query('DELETE FROM activity_samples WHERE at < ?').run(at - retentionMs);
    })();
    this.pending.clear();
  }
}
