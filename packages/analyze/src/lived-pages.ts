import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Cell, type Doc, link, num } from './doc';
import type { Lived, Moment } from './lived';

// The pages of what the v2 residents lived (lived.ts): their decisions, where they broke off or
// found nowhere to go, where they came to grief, and what their days brought.
const PAGE = 500;
const time = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');
const who = (m: { name: string; resident: string }): Cell => ({ text: m.name, href: `/trace/${m.resident}` });
const place = (m: Moment) => (m.x === null ? '' : `${m.x},${m.y}`);

export function livedDecisionsDoc(lived: Lived, page: number, kind?: string): Doc {
  const db = new Database(lived.file, { readonly: true });
  try {
    const kinds = ['considered', 'reconsidered'].filter((k) => !kind || k === kind);
    const rows = db
      .query<{ id: number; at: number; resident: string; kind: string; data: string }, (string | number)[]>(
        `SELECT id, at, resident, kind, data FROM events WHERE kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(...kinds, PAGE, page * PAGE);
    const at = (p: number) => `/decisions?${kind ? `kind=${kind}&` : ''}page=${p}`;
    return {
      title: 'Decisions',
      subtitle: [
        kind ? link('both kinds', '/decisions') : 'both kinds',
        kind === 'considered' ? 'choices' : link('choices', '/decisions?kind=considered'),
        kind === 'reconsidered' ? 'second thoughts' : link('second thoughts', '/decisions?kind=reconsidered'),
        page > 0 ? link('newer', at(page - 1)) : 'newer',
        `page ${page + 1}`,
        rows.length === PAGE ? link('older', at(page + 1)) : 'older'
      ],
      blocks: [
        {
          kind: 'table',
          head: ['When', 'Resident', 'Kind', 'Woken by', 'Outcome', 'Rate', 'Thought (ms)', 'Weighed', ''],
          numeric: [5, 6],
          interactive: true,
          empty: 'No decisions recorded yet.',
          rows: rows.map((r) => {
            const d = JSON.parse(r.data) as Record<string, unknown>;
            const name = lived.residents.get(r.resident)?.name ?? r.resident.slice(0, 8);
            const alternative = d.alternative as { key?: string; rate?: number } | undefined;
            const outcome =
              r.kind === 'considered'
                ? String(d.doing ?? '')
                : d.kept
                  ? `kept ${d.id}`
                  : `switched to ${alternative?.key ?? alternative ?? ''}`;
            const options = (d.options as { key: string }[] | undefined)?.map((o) => o.key) ?? [];
            const traced = typeof d.trace === 'object' && d.trace !== null;
            return [
              { text: time(r.at), href: `/event/${r.id}`, sort: r.at },
              { text: name, href: `/trace/${r.resident}?before=${r.id + 1}` },
              r.kind,
              String(d.trigger || 'start'),
              outcome,
              typeof d.rate === 'number' ? Number(d.rate.toFixed(3)) : (alternative?.rate ?? null),
              typeof d.ms === 'number' ? d.ms : null,
              options.slice(0, 3).join(' · '),
              traced ? { text: '▶ simulate', href: `/simulate/${r.id}` } : ''
            ];
          })
        }
      ]
    };
  } finally {
    db.close();
  }
}

export function livedLoopsDoc(lived: Lived): Doc {
  const by = new Map<string, { m: Moment; n: number }>();
  for (const m of lived.loops) by.set(m.resident, { m, n: (by.get(m.resident)?.n ?? 0) + 1 });
  const reasons = new Map<string, number>();
  for (const m of lived.loops) reasons.set(String(m.data.reason), (reasons.get(String(m.data.reason)) ?? 0) + 1);
  return {
    title: 'Loops',
    subtitle: [
      `${lived.loops.length} times in the day before ${time(lived.newest)} a resident broke off a plan that kept failing or bringing nothing, or found nowhere else to go.`
    ],
    blocks: [
      { kind: 'heading', text: 'Why' },
      {
        kind: 'table',
        head: ['Reason', 'Times'],
        numeric: [1],
        empty: 'None.',
        rows: [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, n]) => [reason, num(n)])
      },
      { kind: 'heading', text: 'By resident' },
      {
        kind: 'table',
        head: ['Resident', 'Times'],
        numeric: [1],
        interactive: true,
        empty: 'None.',
        rows: [...by.values()].sort((a, b) => b.n - a.n).map(({ m, n }) => [who(m), num(n)])
      },
      { kind: 'heading', text: 'Every one (newest first, UTC)' },
      {
        kind: 'table',
        head: ['When', 'Resident', 'Kind', 'Where', 'Reason', 'Plan'],
        interactive: true,
        empty: 'None.',
        rows: lived.loops.map((m) => [
          { text: time(m.at), href: `/event/${m.id}`, sort: m.at },
          who(m),
          m.kind === 'loop-broken' ? 'broke off' : 'nowhere to go',
          place(m),
          String(m.data.reason ?? ''),
          String(m.data.id ?? '')
        ])
      }
    ]
  };
}

export function livedTroubleDoc(lived: Lived): Doc {
  const cells = new Map<string, { n: number; kinds: Map<string, number>; last: number }>();
  for (const m of lived.trouble) {
    if (m.x === null || m.y === null) continue;
    const cell = `${(m.x >> 3) << 3},${(m.y >> 3) << 3}`;
    const entry = cells.get(cell) ?? { n: 0, kinds: new Map<string, number>(), last: 0 };
    cells.set(cell, entry);
    entry.n++;
    entry.kinds.set(m.kind, (entry.kinds.get(m.kind) ?? 0) + 1);
    entry.last = Math.max(entry.last, m.at);
  }
  return {
    title: 'Trouble',
    subtitle: [`Failed walks, strandings and deaths in the six hours before ${time(lived.newest)}.`],
    blocks: [
      { kind: 'heading', text: 'By place (8-tile cells)' },
      {
        kind: 'table',
        head: ['Cell', 'Events', 'Kinds', 'Last'],
        numeric: [1],
        interactive: true,
        empty: 'None.',
        rows: [...cells]
          .sort((a, b) => b[1].n - a[1].n)
          .map(([cell, e]) => [
            cell,
            num(e.n),
            [...e.kinds].map(([k, n]) => `${k} ${n}`).join(', '),
            { text: time(e.last), sort: e.last }
          ])
      },
      { kind: 'heading', text: 'Every one (newest first, UTC)' },
      {
        kind: 'table',
        head: ['When', 'Resident', 'Kind', 'Where', 'Going to'],
        interactive: true,
        empty: 'None.',
        rows: lived.trouble.map((m) => {
          const goal = m.data.goal as { x?: number; y?: number } | undefined;
          return [
            { text: time(m.at), href: `/event/${m.id}`, sort: m.at },
            who(m),
            m.kind,
            place(m),
            goal ? `${goal.x},${goal.y}` : ''
          ];
        })
      }
    ]
  };
}

export function livedSpentDoc(lived: Lived, saves: string): Doc {
  const perDay = goldPerDay(join(saves, '../../ai/residents.sqlite'));
  const share = (plans: Record<string, number>, result: string): Cell => {
    const total = Object.values(plans).reduce((a, b) => a + b, 0);
    const value = total ? Math.round(((plans[result] ?? 0) / total) * 100) : -1;
    return { text: value < 0 ? '—' : `${value}%`, sort: value };
  };
  return {
    title: 'Spent',
    subtitle: [
      `The six hours before ${time(lived.newest)}. Residents decide by their own minds (no model calls); gold a day is the change in carried plus banked gold over the samples kept.`
    ],
    blocks: [
      {
        kind: 'table',
        head: [
          'Resident',
          'Gold a day',
          'Deaths',
          'Choices',
          'Switched',
          'Plans',
          'Completed',
          'Refused',
          'Interrupted'
        ],
        numeric: [1, 2, 3, 4, 5, 6, 7, 8],
        interactive: true,
        empty: 'Nobody has lived yet.',
        rows: [...lived.residents.values()]
          .sort((a, b) => b.last - a.last)
          .map((r) => [
            { text: r.name, href: `/trace/${r.id}` },
            perDay.has(r.id) ? num(perDay.get(r.id) ?? 0) : '—',
            num(r.deaths),
            num(r.decisions),
            num(r.switches),
            num(Object.values(r.plans).reduce((a, b) => a + b, 0)),
            share(r.plans, 'completed'),
            share(r.plans, 'refused'),
            share(r.plans, 'interrupted')
          ])
      }
    ]
  };
}

function goldPerDay(file: string) {
  const found = new Map<string, number>();
  if (!existsSync(file)) return found;
  const db = new Database(file, { readonly: true });
  try {
    const seen = new Map<string, { first: number; firstAt: number; last: number; lastAt: number }>();
    for (const s of db
      .query<{ id: string; at: number; worth: number }, []>(
        'SELECT resident_id AS id, at, COALESCE(gold, 0) + COALESCE(bank, 0) AS worth FROM activity_samples ORDER BY at'
      )
      .all()) {
      const e = seen.get(s.id);
      if (!e) seen.set(s.id, { first: s.worth, firstAt: s.at, last: s.worth, lastAt: s.at });
      else Object.assign(e, { last: s.worth, lastAt: s.at });
    }
    for (const [id, s] of seen)
      if (s.lastAt - s.firstAt > 3_600_000)
        found.set(id, Math.round(((s.last - s.first) / (s.lastAt - s.firstAt)) * 86_400_000));
  } catch {
    // No activity samples in an older resident database.
  } finally {
    db.close();
  }
  return found;
}
