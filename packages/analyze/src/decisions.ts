import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Cell, type Doc, noDatabase, num } from './doc';

// Jev against local decisions at population scale: residents in the model's share (their
// decision traces were offered to the model) beside those deciding by local rules alone, on what
// matters in play: gold over time, deaths, setbacks, and how their decisions turned out. Also the
// model's daily spend (decision_spend: input tokens).
interface Trace {
  source: string;
  reason: string;
}
interface Tally {
  decisions: number;
  divergent: number;
  outcomes: Record<string, number>;
  divergentOutcomes: Record<string, number>;
}

export function decisionsDoc(saves: string): Doc {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return noDatabase('Decisions');
  const db = new Database(file, { readonly: true });
  try {
    const lasting = JSON.parse(
      db.query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?').get('lasting')?.value ?? '{}'
    ) as Record<string, [string, number][]>;
    const deaths = new Map<number, number>();
    for (const [key] of lasting.deaths ?? [])
      deaths.set(Number(key.split('|')[0]), (deaths.get(Number(key.split('|')[0])) ?? 0) + 1);
    const samples = new Map<string, { first: number; firstAt: number; last: number; lastAt: number }>();
    for (const s of db
      .query<{ id: string; at: number; worth: number }, []>(
        'SELECT resident_id AS id, at, COALESCE(gold, 0) + COALESCE(bank, 0) AS worth FROM activity_samples ORDER BY at'
      )
      .all()) {
      const entry = samples.get(s.id);
      if (!entry) samples.set(s.id, { first: s.worth, firstAt: s.at, last: s.worth, lastAt: s.at });
      else Object.assign(entry, { last: s.worth, lastAt: s.at });
    }
    type Group = { residents: number; perDay: number[]; deaths: number; setbacks: number; tally: Tally; model: number };
    const empty = (): Group => ({
      residents: 0,
      perDay: [],
      deaths: 0,
      setbacks: 0,
      model: 0,
      tally: { decisions: 0, divergent: 0, outcomes: {}, divergentOutcomes: {} }
    });
    const groups = { model: empty(), local: empty() };
    for (const row of db
      .query<{ id: string; binding: string | null; checkpoint: string }, []>(
        'SELECT id, binding_json AS binding, checkpoint_json AS checkpoint FROM residents WHERE desired_active = 1'
      )
      .all()) {
      const checkpoint = JSON.parse(row.checkpoint) as {
        decisions?: { history?: Trace[]; tally?: Record<string, Tally> };
        objectives?: Record<string, unknown>;
      };
      const history = checkpoint.decisions?.history ?? [];
      const group = history.some((t) => t.reason !== 'local-provider') ? groups.model : groups.local;
      group.residents++;
      group.model += history.filter((t) => t.source === 'model').length;
      group.setbacks += Object.keys(checkpoint.objectives ?? {}).length;
      const serial = Number((JSON.parse(row.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0);
      group.deaths += deaths.get(serial) ?? 0;
      const s = samples.get(row.id);
      if (s && s.lastAt - s.firstAt > 3_600_000)
        group.perDay.push(((s.last - s.first) / (s.lastAt - s.firstAt)) * 86_400_000);
      for (const t of Object.values(checkpoint.decisions?.tally ?? {})) {
        group.tally.decisions += t.decisions;
        group.tally.divergent += t.divergent;
        for (const [k, v] of Object.entries(t.outcomes)) group.tally.outcomes[k] = (group.tally.outcomes[k] ?? 0) + v;
        for (const [k, v] of Object.entries(t.divergentOutcomes))
          group.tally.divergentOutcomes[k] = (group.tally.divergentOutcomes[k] ?? 0) + v;
      }
    }
    const rate = (o: Record<string, number>): Cell => {
      const total = (o.completed ?? 0) + (o.failed ?? 0);
      const share = total ? Math.round(((o.completed ?? 0) / total) * 100) : -1;
      return { text: share < 0 ? '—' : `${share}%`, sort: share };
    };
    const mean = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0);
    const row = (name: string, g: Group): Cell[] => [
      name,
      num(g.residents),
      num(mean(g.perDay)),
      num(g.residents ? g.deaths / g.residents : 0, 2),
      num(g.residents ? g.setbacks / g.residents : 0, 1),
      num(g.tally.decisions),
      num(g.model),
      num(g.tally.divergent),
      rate(g.tally.outcomes),
      rate(g.tally.divergentOutcomes)
    ];
    const spend = db
      .query<{ day: string; tokens: number }, []>(
        'SELECT day, input_tokens AS tokens FROM decision_spend ORDER BY day DESC LIMIT 14'
      )
      .all();
    return {
      title: 'Decisions',
      subtitle: [
        'Residents asking Jev beside residents deciding locally. Gold a day is the change in carried plus banked gold over the samples kept; deaths are the recent ones kept.'
      ],
      blocks: [
        {
          kind: 'table',
          head: [
            'Group',
            'Residents',
            'Gold a day',
            'Deaths each',
            'Setbacks each',
            'Decisions',
            'Model picks (recent)',
            'Differed from local rule',
            'Success',
            'Success when differing'
          ],
          numeric: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          rows: [row('Jev', groups.model), row('Local', groups.local)]
        },
        { kind: 'heading', text: 'Model spend (input tokens a day)' },
        {
          kind: 'table',
          head: ['Day', 'Input tokens'],
          numeric: [1],
          empty: 'None yet.',
          rows: spend.map((d) => [d.day, num(d.tokens)])
        }
      ]
    };
  } finally {
    db.close();
  }
}
