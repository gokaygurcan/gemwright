import { Database } from 'bun:sqlite';
import { deserialize, serialize } from 'node:v8';

export interface HistoryEvent {
  resident: string;
  at: number;
  kind: string;
  data: object;
  // Where the resident stood when it happened: every event carries its place.
  where?: { x: number; y: number; z: number; map: number | null };
}

// A resident's life, append-only and never evicted: everything perceived, predicted, decided and
// done. Beliefs are derived from it; nothing here is ever updated or deleted.
export class History {
  private readonly db: Database;
  private pending: HistoryEvent[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        resident TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        x INTEGER, y INTEGER, z INTEGER, map INTEGER,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        resident TEXT PRIMARY KEY, compatibility TEXT NOT NULL, through INTEGER NOT NULL, state BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_resident_at ON events (resident, at);
      CREATE INDEX IF NOT EXISTS events_resident_kind ON events (resident, kind, at);`);
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }

  record(event: HistoryEvent) {
    this.pending.push(event);
  }

  flush() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    const insert = this.db.query(
      'INSERT INTO events (resident, at, kind, x, y, z, map, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      for (const e of batch)
        insert.run(
          e.resident,
          e.at,
          e.kind,
          e.where?.x ?? null,
          e.where?.y ?? null,
          e.where?.z ?? null,
          e.where?.map ?? null,
          JSON.stringify(e.data)
        );
    })();
  }

  saveCheckpoint(resident: string, compatibility: string, through: number, state: object) {
    this.flush();
    this.db
      .query('INSERT OR REPLACE INTO checkpoints (resident, compatibility, through, state) VALUES (?, ?, ?, ?)')
      .run(resident, compatibility, through, serialize(state));
  }

  checkpoint<T>(resident: string, compatibility: string): { through: number; state: T } | undefined {
    const row = this.db
      .query<{ through: number; state: Uint8Array }, [string, string]>(
        'SELECT through, state FROM checkpoints WHERE resident = ? AND compatibility = ?'
      )
      .get(resident, compatibility);
    return row ? { through: row.through, state: deserialize(row.state) as T } : undefined;
  }

  // A resident's past events of one kind, oldest first: what its beliefs are rebuilt from.
  read(resident: string, kind: string): object[] {
    this.flush();
    return this.db
      .query<{ data: string }, [string, string]>('SELECT data FROM events WHERE resident = ? AND kind = ? ORDER BY id')
      .all(resident, kind)
      .map((row) => JSON.parse(row.data) as object);
  }

  // The newest event so far: a replay up to it does not meet what this session records after.
  latest() {
    this.flush();
    return this.db.query<{ id: number | null }, []>('SELECT MAX(id) AS id FROM events').get()?.id ?? 0;
  }

  // A resident's past events up to `through`, oldest first, except the kinds named: what it lived.
  *lived(resident: string, through: number, except: readonly string[], after = 0): Generator<HistoryEvent> {
    // Its own reader: the writer keeps committing while the replay walks the past.
    const reader = new Database(this.path, { readonly: true });
    const rows = reader
      .query<
        {
          at: number;
          kind: string;
          x: number | null;
          y: number | null;
          z: number | null;
          map: number | null;
          data: string;
        },
        (string | number)[]
      >(
        `SELECT at, kind, x, y, z, map, data FROM events WHERE resident = ? AND id <= ? AND id > ?
        AND kind NOT IN (${except.map(() => '?').join(', ')}) ORDER BY id`
      )
      .iterate(resident, through, after, ...except);
    try {
      for (const r of rows)
        yield {
          resident,
          at: r.at,
          kind: r.kind,
          data: JSON.parse(r.data) as object,
          ...(r.x === null || r.y === null || r.z === null ? {} : { where: { x: r.x, y: r.y, z: r.z, map: r.map } })
        };
    } finally {
      reader.close();
    }
  }

  close() {
    clearInterval(this.timer);
    this.flush();
    this.db.close();
  }
}

const open = new Map<string, History>();
export const historyAt = (path: string) => {
  const history = open.get(path) ?? new History(path);
  open.set(path, history);
  return history;
};
