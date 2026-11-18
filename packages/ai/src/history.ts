import { Database } from 'bun:sqlite';
import { deserialize, serialize } from 'node:v8';

export interface HistoryEvent {
  resident: string;
  at: number;
  kind: string;
  data: object;
  // Where the resident stood when it happened: every event carries its place.
  where?: { x: number; y: number; z: number; map: number | null };
  // How the live mind met it (simulate.ts replays exactly that): perceived (its places and mind
  // observed it), noticed (its mind observed it), or only told (written down, never observed).
  via?: 'perceived' | 'noticed' | 'told';
}

// Where a waking began: the checkpoint it restored (none when it re-lived from the start), the
// history it re-lived through, and who it was then. A decision is re-lived from it (simulate.ts).
export interface Wake {
  id: number;
  resident: string;
  at: number;
  through: number;
  after: number;
  trade: string[];
  supporting: string[];
  state?: object;
}

// A resident's life, append-only and never evicted: everything perceived, predicted, decided and
// done. Beliefs are derived from it; nothing here is ever updated or deleted.
export class History {
  private readonly db: Database;
  private pending: HistoryEvent[] = [];
  private readonly timer?: ReturnType<typeof setInterval>;
  // The id the last event recorded has, or will have once written: events are numbered as recorded.
  private last = 0;

  constructor(
    readonly path: string,
    readonly readonly = false
  ) {
    this.db = new Database(path, readonly ? { readonly: true, strict: true } : { create: true, strict: true });
    if (readonly) return;
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
      CREATE INDEX IF NOT EXISTS events_resident_kind ON events (resident, kind, at);
      CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
      CREATE TABLE IF NOT EXISTS wakes (
        id INTEGER PRIMARY KEY, resident TEXT NOT NULL, at INTEGER NOT NULL, through INTEGER NOT NULL,
        after INTEGER NOT NULL, trade TEXT NOT NULL, supporting TEXT NOT NULL, state BLOB
      );`);
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(events)').all();
    if (!columns.some((c) => c.name === 'via')) this.db.exec('ALTER TABLE events ADD COLUMN via TEXT');
    this.last = this.db.query<{ id: number | null }, []>('SELECT MAX(id) AS id FROM events').get()?.id ?? 0;
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }

  // Its id: what it will be written under.
  record(event: HistoryEvent) {
    this.pending.push(event);
    return ++this.last;
  }

  // The id of the newest event recorded so far, written or not.
  mark() {
    return this.last;
  }

  flush() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    const insert = this.db.query(
      'INSERT INTO events (id, resident, at, kind, x, y, z, map, data, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const first = this.last - batch.length - this.pending.length + 1;
    this.db.transaction(() => {
      for (const [i, e] of batch.entries())
        insert.run(
          first + i,
          e.resident,
          e.at,
          e.kind,
          e.where?.x ?? null,
          e.where?.y ?? null,
          e.where?.z ?? null,
          e.where?.map ?? null,
          JSON.stringify(e.data),
          e.via ?? null
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

  saveWake(wake: Omit<Wake, 'id'>) {
    this.db
      .query('INSERT INTO wakes (resident, at, through, after, trade, supporting, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        wake.resident,
        wake.at,
        wake.through,
        wake.after,
        JSON.stringify(wake.trade),
        JSON.stringify(wake.supporting),
        wake.state ? serialize(wake.state) : null
      );
    // A mind's state at a waking is megabytes: only its latest few are kept to re-live from.
    this.db
      .query(
        'UPDATE wakes SET state = NULL WHERE resident = ? AND state IS NOT NULL AND id NOT IN (SELECT id FROM wakes WHERE resident = ? ORDER BY id DESC LIMIT ?)'
      )
      .run(wake.resident, wake.resident, KEPT_WAKES);
  }

  // The waking a resident's event `id` belongs to: its latest before it.
  wakeBefore(resident: string, id: number, wake?: number): Wake | undefined {
    const row = this.db
      .query<
        {
          id: number;
          at: number;
          through: number;
          after: number;
          trade: string;
          supporting: string;
          state: Uint8Array | null;
        },
        [string, number, number | null, number | null]
      >('SELECT * FROM wakes WHERE resident = ? AND through < ? AND (? IS NULL OR id = ?) ORDER BY id DESC LIMIT 1')
      .get(resident, id, wake ?? null, wake ?? null);
    return row
      ? {
          ...row,
          resident,
          trade: JSON.parse(row.trade) as string[],
          supporting: JSON.parse(row.supporting) as string[],
          state: row.state ? (deserialize(row.state) as object) : undefined
        }
      : undefined;
  }

  // Every waking of a resident, oldest first.
  wakes(resident: string): Wake[] {
    return this.db
      .query<{ id: number }, [string]>('SELECT id FROM wakes WHERE resident = ? ORDER BY id')
      .all(resident)
      .flatMap((row) => this.wakeBefore(resident, Number.MAX_SAFE_INTEGER, row.id) ?? []);
  }

  // One event by its id.
  event(id: number): (HistoryEvent & { id: number }) | undefined {
    this.flush();
    const row = this.db
      .query<Row & { id: number; resident: string }, [number]>('SELECT * FROM events WHERE id = ?')
      .get(id);
    return row ? { id: row.id, ...fromRow(row.resident, row) } : undefined;
  }

  // A resident's events after `after` up to `through`, as they were met (simulate.ts).
  *between(resident: string, after: number, through: number): Generator<HistoryEvent & { id: number }> {
    const rows = this.db
      .query<Row & { id: number }, [string, number, number]>(
        'SELECT * FROM events WHERE +resident = ? AND id > ? AND id <= ? ORDER BY id'
      )
      .iterate(resident, after, through);
    for (const row of rows) yield { id: row.id, ...fromRow(resident, row) };
  }

  // A resident's past events of one kind, oldest first: what its beliefs are rebuilt from; up to
  // `through` when given.
  read(resident: string, kind: string, through = Number.MAX_SAFE_INTEGER, after = 0): object[] {
    this.flush();
    return this.db
      .query<{ data: string }, [string, string, number, number]>(
        `SELECT data FROM events WHERE ${after ? '+resident = ? AND +kind' : 'resident = ? AND kind'} = ? AND id <= ? AND id > ? ORDER BY id`
      )
      .all(resident, kind, through, after)
      .map((row) => JSON.parse(row.data) as object);
  }

  recent(kind: string, since: number, through = Number.MAX_SAFE_INTEGER): HistoryEvent[] {
    this.flush();
    return this.db
      .query<{ resident: string; at: number; data: string }, [string, number, number]>(
        'SELECT resident, at, data FROM events WHERE kind = ? AND at >= ? AND id <= ? ORDER BY id DESC LIMIT 20000'
      )
      .all(kind, since, through)
      .reverse()
      .map((row) => ({ ...row, kind, data: JSON.parse(row.data) as object }));
  }

  // The newest event so far: a replay up to it does not meet what this session records after.
  latest() {
    this.flush();
    return this.readonly ? this.newest() : this.last;
  }

  private newest() {
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
        // From a checkpoint, the few events after it are found by their ids alone (`+resident` keeps the
        // resident's index, which would walk its whole past, out of it); from nothing, by resident.
        `SELECT at, kind, x, y, z, map, data FROM events WHERE ${after ? '+resident' : 'resident'} = ? AND id <= ? AND id > ?
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
    if (this.timer) clearInterval(this.timer);
    this.flush();
    this.db.close();
  }
}

type Row = {
  at: number;
  kind: string;
  x: number | null;
  y: number | null;
  z: number | null;
  map: number | null;
  data: string;
  via: string | null;
};
const fromRow = (resident: string, r: Row): HistoryEvent => ({
  resident,
  at: r.at,
  kind: r.kind,
  data: JSON.parse(r.data) as object,
  ...(r.x === null || r.y === null || r.z === null ? {} : { where: { x: r.x, y: r.y, z: r.z, map: r.map } }),
  ...(r.via ? { via: r.via as HistoryEvent['via'] } : {})
});

// The wakings of each resident whose state is kept: decisions since the oldest of them can be simulated.
const KEPT_WAKES = 3;

const open = new Map<string, History>();
export const historyAt = (path: string) => {
  const history = open.get(path) ?? new History(path);
  open.set(path, history);
  return history;
};
