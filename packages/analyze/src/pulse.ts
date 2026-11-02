import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The shard's last day from the resident database a pull brings along: the AI's five-minute
// samples of the population (population_metrics: online, stalls) and of every active resident
// (activity_samples: where it was, its phase, carried gold and bank).
export interface Pulse {
  // When the last sample was taken; every window below ends there.
  end: number;
  online: [number, number][];
  stalls: number[];
  wealth: [number, number][];
  phases: Map<string, number>;
  // Per active resident (by character serial), its samples over the last day, oldest first.
  residents: Map<number, { at: number; x: number; y: number; map: number; phase: string; money: number }[]>;
}

const DAY = 24 * 3_600_000;

export function readPulse(saves: string): Pulse | undefined {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const end = db.query<{ at: number | null }, []>('SELECT MAX(at) AS at FROM activity_samples').get()?.at;
    if (!end) return undefined;
    const since = end - DAY;
    const metrics = db
      .query<{ at: number; online: number; stalls: number }, [number]>(
        'SELECT at, online, stalls FROM population_metrics WHERE at >= ? ORDER BY at'
      )
      .all(since);
    const serials = new Map(
      db
        .query<{ id: string; binding: string | null }, []>(
          'SELECT id, binding_json AS binding FROM residents WHERE desired_active = 1'
        )
        .all()
        .map((r) => [
          r.id,
          Number((JSON.parse(r.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0)
        ])
    );
    const samples = db
      .query<
        { id: string; at: number; map: number; x: number; y: number; phase: string | null; gold: number; bank: number },
        [number]
      >('SELECT resident_id AS id, at, map, x, y, phase, gold, bank FROM activity_samples WHERE at >= ? ORDER BY at')
      .all(since - 6 * 3_600_000);
    // Wealth at each sample time: every resident's latest known gold, so a logout is not a loss
    // (the six hours before the window seed it).
    const latest = new Map<number, number>();
    const wealth = new Map<number, number>();
    let sum = 0;
    const phases = new Map<string, number>();
    const residents: Pulse['residents'] = new Map();
    for (const s of samples) {
      const serial = serials.get(s.id);
      if (!serial) continue;
      const money = s.gold + s.bank;
      sum += money - (latest.get(serial) ?? 0);
      latest.set(serial, money);
      if (s.at < since) continue;
      wealth.set(s.at, sum);
      const phase = s.phase ?? '';
      phases.set(phase, (phases.get(phase) ?? 0) + 1);
      const list = residents.get(serial) ?? [];
      residents.set(serial, list);
      list.push({ at: s.at, x: s.x, y: s.y, map: s.map, phase, money });
    }
    return {
      end,
      online: metrics.map((m) => [m.at, m.online]),
      stalls: metrics.filter((m) => m.stalls > 0).map((m) => m.at),
      wealth: [...wealth],
      phases,
      residents
    };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
