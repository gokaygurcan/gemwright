import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// What the v2 residents lived, from their history (<pull>/ai/history.sqlite, packages/ai v2/history.ts):
// the facts the pages count, each over the hours before the history's newest event, so an old pull
// reads as of when it was taken. Residents are matched to the save by their character serial
// (<pull>/ai/residents.sqlite).
export interface Moment {
  at: number;
  id: number;
  resident: string;
  name: string;
  serial: number;
  kind: string;
  x: number | null;
  y: number | null;
  data: Record<string, unknown>;
}

export interface LivedResident {
  id: string;
  name: string;
  serial: number;
  last: number;
  doing: string;
  why: string;
  deaths: number;
  stranded: number;
  refused: number;
  decisions: number;
  switches: number;
  plans: Record<string, number>;
  bank?: number;
}

export interface Lived {
  file: string;
  newest: number;
  residents: Map<string, LivedResident>;
  // Every time it broke off what it was doing, or could find nowhere to go (a day).
  loops: Moment[];
  // Walks that failed, places it was stranded, and deaths (six hours).
  trouble: Moment[];
}

const HOUR = 3_600_000;

export function readLived(saves: string): Lived | undefined {
  const file = join(saves, '../../ai/history.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const newest = db.query<{ at: number | null }, []>('SELECT MAX(at) AS at FROM events').get()?.at;
    if (!newest) return undefined;
    const known = identities(join(saves, '../../ai/residents.sqlite'));
    const residents = new Map<string, LivedResident>();
    const resident = (id: string) => {
      let r = residents.get(id);
      if (!r) {
        const who = known.get(id);
        r = {
          id,
          name: who?.name ?? id.slice(0, 8),
          serial: who?.serial ?? 0,
          last: 0,
          doing: '',
          why: '',
          deaths: 0,
          stranded: 0,
          refused: 0,
          decisions: 0,
          switches: 0,
          plans: {},
          bank: who?.bank
        };
        residents.set(id, r);
      }
      return r;
    };
    for (const row of db
      .query<{ resident: string; last: number }, []>('SELECT resident, MAX(at) AS last FROM events GROUP BY resident')
      .all())
      resident(row.resident).last = row.last;
    const moments = (kinds: string[], since: number) =>
      db
        .query<
          { id: number; at: number; resident: string; kind: string; x: number | null; y: number | null; data: string },
          (string | number)[]
        >(
          `SELECT id, at, resident, kind, x, y, data FROM events WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND at >= ? ORDER BY id DESC`
        )
        .all(...kinds, since)
        .map((r) => {
          const who = resident(r.resident);
          return { ...r, name: who.name, serial: who.serial, data: JSON.parse(r.data) as Record<string, unknown> };
        });
    for (const m of moments(['narrated'], 0).reverse()) {
      const who = resident(m.resident);
      if (typeof m.data.doing === 'string') who.doing = m.data.doing;
      if (typeof m.data.why === 'string') who.why = m.data.why;
    }
    const recent = newest - 6 * HOUR;
    const trouble = moments(['stranded', 'route-failed', 'died'], recent);
    for (const m of trouble) {
      if (m.kind === 'died') resident(m.resident).deaths++;
      if (m.kind === 'stranded') resident(m.resident).stranded++;
    }
    for (const m of moments(['plan-ended'], recent)) {
      const who = resident(m.resident);
      const result = String(m.data.result);
      who.plans[result] = (who.plans[result] ?? 0) + 1;
      if (result === 'refused') who.refused++;
    }
    for (const m of moments(['considered', 'reconsidered'], recent)) {
      const who = resident(m.resident);
      if (m.kind === 'considered') who.decisions++;
      else if (m.data.kept === false) who.switches++;
    }
    return {
      file,
      newest,
      residents,
      loops: moments(['loop-broken', 'loop-blocked'], newest - 24 * HOUR),
      trouble
    };
  } finally {
    db.close();
  }
}

function identities(file: string) {
  const found = new Map<string, { name: string; serial: number; bank?: number }>();
  if (!existsSync(file)) return found;
  const db = new Database(file, { readonly: true });
  try {
    for (const r of db
      .query<{ id: string; name: string; binding: string | null }, []>(
        'SELECT id, proposed_name AS name, binding_json AS binding FROM residents'
      )
      .all())
      found.set(r.id, {
        name: r.name,
        serial: Number((JSON.parse(r.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0)
      });
    // The bank as last sampled.
    for (const s of db
      .query<{ id: string; bank: number | null }, []>(
        'SELECT resident_id AS id, bank FROM activity_samples WHERE rowid IN (SELECT MAX(rowid) FROM activity_samples GROUP BY resident_id)'
      )
      .all()) {
      const who = found.get(s.id);
      if (who && s.bank !== null) who.bank = s.bank;
    }
  } catch {
    // An older resident database without activity samples: names and serials only.
  } finally {
    db.close();
  }
  return found;
}

// The resident rows (residents.ts) as the v2 residents lived them: what they are doing and why, when
// last active, their recent deaths, strandings and refused plans, and their bank as last sampled.
export function withLived<
  T extends {
    serial: number;
    phase: string;
    note: string;
    lastActive: number;
    bank: number;
    setbacks: number;
    deaths: number;
    stranded: number;
  }
>(rows: T[] | undefined, lived: Lived | undefined): T[] | undefined {
  if (!rows || !lived) return rows;
  const bySerial = new Map([...lived.residents.values()].map((r) => [r.serial, r]));
  return rows.map((row) => {
    const r = bySerial.get(row.serial);
    return r
      ? {
          ...row,
          phase: r.doing,
          note: r.why,
          lastActive: r.last,
          bank: r.bank ?? row.bank,
          setbacks: r.refused,
          deaths: r.deaths,
          stranded: r.stranded
        }
      : row;
  });
}
