import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Analysis } from './analysis';
import { type Doc, link, noDatabase, num } from './doc';

// One row per AI resident: what it is doing, whether it is getting anywhere, and its trouble,
// from the resident database a pull brings along (<pull>/ai/residents.sqlite: each checkpoint and
// the kept timers, packages/ai/src/lasting.ts) joined with the save (skills, carried gold).
export interface ResidentRow {
  serial: number;
  name: string;
  trade: string;
  phase: string;
  note: string;
  lastActive: number;
  bank: number;
  setbacks: number;
  deaths: number;
  stranded: number;
  sideTrade: boolean;
}

export function readResidents(saves: string): ResidentRow[] | undefined {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const lasting = JSON.parse(
      db.query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?').get('lasting')?.value ?? '{}'
    ) as Record<string, [string, number][]>;
    const per = (table: string) => {
      const counts = new Map<number, number>();
      for (const [key, until] of lasting[table] ?? [])
        if (until > Date.now() - 6 * 3_600_000) {
          const serial = Number(key.split('|')[0]);
          counts.set(serial, (counts.get(serial) ?? 0) + 1);
        }
      return counts;
    };
    const deaths = per('deaths');
    const stranded = per('stranded');
    const rows = db
      .query<{ name: string; template: string; binding: string | null; checkpoint: string }, []>(
        'SELECT proposed_name AS name, template_id AS template, binding_json AS binding, checkpoint_json AS checkpoint FROM residents WHERE desired_active = 1'
      )
      .all();
    return rows.map((row) => {
      const checkpoint = JSON.parse(row.checkpoint) as {
        goal?: { phase?: string; note?: string } | null;
        memories?: { at: string }[];
        funds?: { bank: number };
        objectives?: Record<string, unknown>;
        sideTrade?: { until: number };
      };
      const serial = Number((JSON.parse(row.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0);
      return {
        serial,
        name: row.name,
        trade: row.template,
        phase: checkpoint.goal?.phase ?? '',
        note: checkpoint.goal?.note ?? '',
        lastActive: Date.parse(checkpoint.memories?.at(-1)?.at ?? '') || 0,
        bank: checkpoint.funds?.bank ?? 0,
        setbacks: Object.keys(checkpoint.objectives ?? {}).length,
        deaths: deaths.get(serial) ?? 0,
        stranded: stranded.get(serial) ?? 0,
        sideTrade: (checkpoint.sideTrade?.until ?? 0) > Date.now()
      };
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

// The worst residents come first (most trouble); every column sorts.
export function residentsDoc(a: Analysis, rows: ResidentRow[] | undefined): Doc {
  if (!rows) return noDatabase('Residents');
  const bySerial = new Map(a.characters.map((c) => [c.serial, c]));
  const trouble = (r: ResidentRow) => r.deaths * 3 + r.stranded + r.setbacks;
  return {
    title: 'Residents',
    subtitle: [`${rows.length} active residents, most trouble first. Gold is carried plus last known bank balance.`],
    blocks: [
      {
        kind: 'table',
        head: [
          'Name',
          'Trade',
          'Phase',
          'Doing',
          'Last active',
          'Skills',
          'Gold',
          'Deaths (6h)',
          'Stranded (6h)',
          'Setbacks'
        ],
        numeric: [4, 5, 6, 7, 8, 9],
        interactive: true,
        rows: [...rows]
          .sort((x, y) => trouble(y) - trouble(x))
          .map((r) => {
            const c = bySerial.get(r.serial);
            const ago = r.lastActive ? Math.round((Date.now() - r.lastActive) / 60_000) : -1;
            return [
              link(r.name, `/replay/${r.serial}`),
              r.trade,
              `${r.phase}${r.sideTrade ? ' (side trade)' : ''}`,
              r.note.slice(0, 90),
              { text: ago < 0 ? '' : `${ago} min`, sort: ago },
              num(c?.skillTotal ?? 0, 1),
              num((c?.gold.carried ?? 0) + r.bank),
              num(r.deaths),
              num(r.stranded),
              num(r.setbacks)
            ];
          })
      }
    ]
  };
}
