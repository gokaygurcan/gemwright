import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Doc, noDatabase, num } from './doc';

// Where the residents' walks keep going wrong: the AI's kept timers (packages/ai/src/lasting.ts),
// read from the resident database a pull brings along (<pull>/ai/residents.sqlite). Trouble
// events are kept by 8-tile cell for six hours; a cell with three or more is avoided by routes.
type Tables = Record<string, [string, number][]>;

export function readLasting(saves: string): Tables | undefined {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const row = db.query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?').get('lasting');
    return row ? (JSON.parse(row.value) as Tables) : {};
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export function troubleDoc(tables: Tables | undefined): Doc {
  if (!tables) return noDatabase('Trouble');
  const cells = new Map<string, { total: number; kinds: Map<string, number>; last: number }>();
  for (const [key] of tables.trouble ?? []) {
    const [cell = '', kind = '', at = '0'] = key.split('|');
    const entry = cells.get(cell) ?? { total: 0, kinds: new Map<string, number>(), last: 0 };
    cells.set(cell, entry);
    entry.total++;
    entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
    entry.last = Math.max(entry.last, Number(at));
  }
  const count = (name: string) => (tables[name] ?? []).length;
  // Deaths in the last day by 16-tile area, with what was near (resurrection.ts).
  const deaths = new Map<string, { n: number; causes: Map<string, number>; residents: Set<string> }>();
  for (const [key] of tables['death-log'] ?? []) {
    const [resident = '', place = '', cause = 'unknown'] = key.split('|');
    const [x = 0, y = 0] = place.split(',').map(Number);
    const area = `${(x >> 4) * 16 + 8},${(y >> 4) * 16 + 8}`;
    const entry = deaths.get(area) ?? { n: 0, causes: new Map<string, number>(), residents: new Set<string>() };
    deaths.set(area, entry);
    entry.n++;
    entry.causes.set(cause, (entry.causes.get(cause) ?? 0) + 1);
    entry.residents.add(resident);
  }
  const listed = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  return {
    title: 'Trouble',
    subtitle: [
      `Failed walks and stuck calls in the last six hours, by 8-tile area. Kept now: ${count('unreachable')} unreachable places, ${count('danger')} danger areas, ${count('deaths')} recent deaths, ${count('stuck-menu')} stuck-menu uses.`
    ],
    blocks: [
      { kind: 'heading', text: 'Deaths in the last day' },
      {
        kind: 'table',
        head: ['Area', 'Deaths', 'Residents', 'Near'],
        numeric: [1, 2],
        empty: 'None recorded yet.',
        rows: [...deaths]
          .sort(([, a], [, b]) => b.n - a.n)
          .map(([area, e]) => [area, num(e.n), num(e.residents.size), listed(e.causes)])
      },
      { kind: 'heading', text: 'Failed walks and stuck calls' },
      {
        kind: 'table',
        head: ['Place', 'Events', 'Kinds', 'Routes', 'Last (UTC)'],
        numeric: [1],
        empty: 'Nothing recorded.',
        rows: [...cells]
          .sort(([, a], [, b]) => b.total - a.total)
          .map(([cell, e]) => {
            const [cx = 0, cy = 0] = cell.split(',').map(Number);
            return [
              `${cx * 8 + 4},${cy * 8 + 4}`,
              num(e.total),
              listed(e.kinds),
              e.total >= 3 ? { text: 'avoided', tone: 'error' } : '',
              new Date(e.last).toISOString().slice(0, 16).replace('T', ' ')
            ];
          })
      }
    ]
  };
}
