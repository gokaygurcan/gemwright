import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Analysis } from './analysis';
import { type Doc, link, noDatabase, num } from './doc';

// One row per AI resident: the roster a pull brings along (<pull>/ai/residents.sqlite), what it is
// doing and its trouble as it lived them (lived.ts withLived), joined with the save (skills, gold).
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
}

export function readResidents(saves: string): ResidentRow[] | undefined {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query<{ name: string; template: string; binding: string | null }, []>(
        'SELECT proposed_name AS name, template_id AS template, binding_json AS binding FROM residents WHERE desired_active = 1'
      )
      .all();
    return rows.map((row) => ({
      serial: Number((JSON.parse(row.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0),
      name: row.name,
      trade: row.template,
      phase: '',
      note: '',
      lastActive: 0,
      bank: 0,
      setbacks: 0,
      deaths: 0,
      stranded: 0
    }));
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
              r.phase,
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
