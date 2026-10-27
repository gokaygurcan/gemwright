import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Doc, noDatabase, num } from './doc';

// The residents' economy from the resident database a pull brings along: per trade, what they
// own and how it moves day by day (activity_samples: gold and bank over time), what they made,
// gathered, sold and bought (activity totals), and the deals between residents (trade_log).
const COUNTS = [
  'mined',
  'chopped',
  'fished',
  'crafted',
  'kills',
  'goldFromShops',
  'goldToShops',
  'trades',
  'tradeGoldIn',
  'boughtFromResidents',
  'soldToResidents',
  'recalls'
] as const;

export function economyDoc(saves: string): Doc {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return noDatabase('Economy');
  const db = new Database(file, { readonly: true });
  try {
    const trades = new Map(
      db
        .query<{ id: string; template: string }, []>(
          'SELECT id, template_id AS template FROM residents WHERE desired_active = 1'
        )
        .all()
        .map((r) => [
          r.id,
          r.template.replace(/^(?:skara-brae|britain|jhelom|magincia|minoc|moonglow|trinsic|vesper|yew)-/, '')
        ])
    );
    const trade = (id: string) => trades.get(id) ?? 'other';
    // Totals per trade.
    const totals = new Map<string, Record<string, number>>();
    for (const row of db
      .query<{ id: string; totals: string }, []>('SELECT resident_id AS id, totals_json AS totals FROM activity')
      .all()) {
      const t = totals.get(trade(row.id)) ?? {};
      for (const [k, v] of Object.entries(JSON.parse(row.totals) as Record<string, number>)) t[k] = (t[k] ?? 0) + v;
      totals.set(trade(row.id), t);
    }
    // Gold and bank per resident per day: the last sample of each day.
    const days = new Map<string, Map<string, number>>();
    for (const s of db
      .query<{ id: string; at: number; gold: number; bank: number }, []>(
        'SELECT resident_id AS id, at, gold, bank FROM activity_samples ORDER BY at'
      )
      .all()) {
      const day = new Date(s.at).toISOString().slice(0, 10);
      const perDay = days.get(s.id) ?? new Map<string, number>();
      perDay.set(day, (s.gold ?? 0) + (s.bank ?? 0));
      days.set(s.id, perDay);
    }
    const allDays = [...new Set([...days.values()].flatMap((d) => [...d.keys()]))].sort();
    const worth = new Map<string, { n: number; now: number; change: Map<string, number[]> }>();
    for (const [id, perDay] of days) {
      const w = worth.get(trade(id)) ?? { n: 0, now: 0, change: new Map<string, number[]>() };
      worth.set(trade(id), w);
      w.n++;
      w.now += [...perDay.values()].at(-1) ?? 0;
      let previous: number | undefined;
      for (const day of allDays) {
        const value = perDay.get(day);
        if (value === undefined) continue;
        if (previous !== undefined) w.change.set(day, [...(w.change.get(day) ?? []), value - previous]);
        previous = value;
      }
    }
    const mean = (values: number[] = []) =>
      values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
    const names = [...new Set([...worth.keys(), ...totals.keys()])].sort();
    const deals = db
      .query<{ day: string; n: number; done: number; gold: number }, []>(
        "SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(completed) AS done, SUM(CASE WHEN completed THEN price ELSE 0 END) AS gold FROM trade_log WHERE role = 'seller' GROUP BY day ORDER BY day"
      )
      .all();
    const shownDays = allDays.slice(1);
    return {
      title: 'Economy',
      subtitle: ['Gold is carried plus banked. Counts are totals since the residents began.'],
      blocks: [
        { kind: 'heading', text: 'By trade' },
        {
          kind: 'table',
          head: [
            'Trade',
            'Residents',
            'Gold each',
            'Change a day',
            ...COUNTS.map((k) => k.replace(/([A-Z])/g, ' $1').toLowerCase())
          ],
          numeric: Array.from({ length: COUNTS.length + 3 }, (_, i) => i + 1),
          interactive: true,
          rows: names.map((name) => {
            const w = worth.get(name);
            const t = totals.get(name) ?? {};
            return [
              name,
              num(w?.n ?? 0),
              num(w ? Math.round(w.now / w.n) : 0),
              num(mean([...(w?.change.values() ?? [])].flat())),
              ...COUNTS.map((k) => num(t[k] ?? 0))
            ];
          })
        },
        { kind: 'heading', text: 'Average change in gold per resident, by day' },
        {
          kind: 'table',
          head: ['Trade', ...shownDays.map((d) => d.slice(5))],
          numeric: shownDays.map((_, i) => i + 1),
          rows: names.map((name) => [name, ...shownDays.map((d) => num(mean(worth.get(name)?.change.get(d))))])
        },
        { kind: 'heading', text: 'Deals between residents' },
        {
          kind: 'table',
          head: ['Day', 'Agreed', 'Completed', 'Gold'],
          numeric: [1, 2, 3],
          empty: 'None yet.',
          rows: deals.map((d) => [d.day, num(d.n), num(d.done), num(d.gold ?? 0)])
        }
      ]
    };
  } finally {
    db.close();
  }
}
