import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Cell, type Doc, link } from './doc';

// Everything a resident lived, newest first: each thing it perceived, noticed, said to itself,
// decided and did, as its history holds it (ai/history.sqlite). A decision can be weighed again
// from what it knew then (/simulate/<id>).
const PAGE = 500;
const decisions = new Set(['considered', 'reconsidered']);

const opened = (saves: string) => {
  const file = join(saves, '../../ai/history.sqlite');
  return existsSync(file) ? new Database(file, { readonly: true }) : undefined;
};

export function traceDoc(saves: string, resident: string, page: number, kinds?: string, before?: number): Doc {
  const db = opened(saves);
  if (!db) return { title: 'Trace', blocks: [{ kind: 'note', text: 'This pull has no history.' }] };
  try {
    const where = ['resident = ?'];
    const args: (string | number)[] = [resident];
    const only = kinds?.split(',').filter(Boolean) ?? [];
    if (only.length) {
      where.push(`kind IN (${only.map(() => '?').join(', ')})`);
      args.push(...only);
    }
    if (before) {
      where.push('id < ?');
      args.push(before);
    }
    const rows = db
      .query<
        { id: number; at: number; kind: string; x: number | null; y: number | null; data: string; via?: string | null },
        (string | number)[]
      >(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`)
      .all(...args);
    const counts = db
      .query<{ kind: string; n: number }, [string]>(
        'SELECT kind, COUNT(*) AS n FROM events WHERE resident = ? GROUP BY kind ORDER BY n DESC'
      )
      .all(resident);
    const query = (p: number) =>
      `/trace/${resident}?page=${p}${kinds ? `&kind=${kinds}` : ''}${before ? `&before=${before}` : ''}`;
    return {
      title: `Trace of ${resident.slice(0, 8)}`,
      subtitle: [
        `page ${page + 1}`,
        ...(page ? [link('newer', query(page - 1))] : []),
        ...(rows.length === PAGE ? [link('older', query(page + 1))] : []),
        ...(kinds ? [link('every kind', `/trace/${resident}`)] : [])
      ],
      blocks: [
        { kind: 'heading', text: 'Kinds (click to show one)' },
        {
          kind: 'table',
          head: ['Kind', 'Events'],
          numeric: [1],
          rows: counts.map((c) => [{ text: c.kind, href: `/trace/${resident}?kind=${c.kind}` }, c.n])
        },
        { kind: 'heading', text: 'Events (newest first, UTC)' },
        {
          kind: 'table',
          head: ['Time', 'Event', 'Kind', 'Via', 'Where', 'What'],
          interactive: true,
          empty: 'Nothing recorded.',
          rows: rows.map((r): Cell[] => [
            new Date(r.at).toISOString().slice(0, 23).replace('T', ' '),
            { text: String(r.id), href: `/event/${r.id}` },
            decisions.has(r.kind) ? { text: `${r.kind} ▶ simulate`, href: `/simulate/${r.id}` } : r.kind,
            r.via ?? '',
            r.x === null ? '' : `${r.x},${r.y}`,
            summary(r.kind, r.data)
          ])
        }
      ]
    };
  } finally {
    db.close();
  }
}

// What a decision chose, and a narration in words; anything else as its data, shortened.
export function summary(kind: string, raw: string) {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (kind === 'considered')
    return `${data.doing} (rate ${Number(data.rate ?? 0).toFixed(3)}, ${data.ms} ms after ${data.trigger || 'start'})`;
  if (kind === 'reconsidered')
    return `${data.kept ? 'kept' : 'switched from'} ${data.id}${data.kept ? '' : ` to ${(data.alternative as { id?: string })?.id}`} (${data.ms} ms after ${data.trigger})`;
  if (kind === 'narrated') return String(data.doing ?? `why: ${data.why}`);
  const { trace: _, ...rest } = data;
  const text = JSON.stringify(rest);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function eventDoc(saves: string, id: number): Doc | undefined {
  const db = opened(saves);
  if (!db) return undefined;
  try {
    const row = db
      .query<{ resident: string; at: number; kind: string; data: string }, [number]>(
        'SELECT * FROM events WHERE id = ?'
      )
      .get(id);
    if (!row) return undefined;
    return {
      title: `${row.kind} #${id}`,
      subtitle: [
        new Date(row.at).toISOString(),
        link('trace from here', `/trace/${row.resident}?before=${id + 1}`),
        ...(decisions.has(row.kind) ? [link('simulate', `/simulate/${id}`)] : [])
      ],
      blocks: [{ kind: 'pre', text: JSON.stringify(JSON.parse(row.data), null, 2) }]
    };
  } finally {
    db.close();
  }
}

type Option = { id: string; key: string; value?: number; rate?: number; seconds?: number };
const round = (n: number | undefined, digits: number) => (n === undefined ? null : Number(n.toFixed(digits)));
type Simulation = {
  id: number;
  resident: string;
  kind: string;
  at: number;
  wake: { id: number; at: number; restored: boolean };
  relived: number;
  during: number;
  same: boolean;
  recorded: { digest?: string; options: Option[] };
  simulated: { digest?: string; options: Option[] };
  unanswered: string[];
  parted?: { at: number; live?: unknown[]; simulated?: unknown[] };
  ms: number;
};

// A decision weighed again (the AI's simulate.ts), beside what it weighed live.
export function simulationDoc(report: Simulation): Doc {
  const rows = (options: Option[]) =>
    options.map((o) => [o.key, o.id, round(o.rate, 4), round(o.value, 2), round(o.seconds, 1)]);
  return {
    title: `${report.kind} #${report.id} simulated`,
    subtitle: [
      new Date(report.at).toISOString(),
      link('trace', `/trace/${report.resident}?before=${report.id + 1}`),
      link('event', `/event/${report.id}`)
    ],
    blocks: [
      {
        kind: 'note',
        text: report.same
          ? 'Same result: weighed again, it came to exactly what it came to live.'
          : `Different result: live ${report.recorded.digest}, simulated ${report.simulated.digest}.`
      },
      {
        kind: 'fields',
        rows: [
          [
            'Woke',
            `${new Date(report.wake.at).toISOString()} (${report.wake.restored ? 'from a checkpoint' : 'from birth'})`
          ],
          ['Events re-lived', report.relived],
          ['Events met while weighing', report.during],
          ['Encounter questions never asked live', report.unanswered.join(', ') || 'none'],
          [
            'First difference',
            report.parted
              ? `option ${report.parted.at + 1}: live ${JSON.stringify(report.parted.live ?? null)}, simulated ${JSON.stringify(report.parted.simulated ?? null)}`
              : 'none'
          ],
          ['Simulation took', `${report.ms} ms`]
        ]
      },
      { kind: 'heading', text: 'Live' },
      {
        kind: 'table',
        head: ['Plan', 'Id', 'Rate', 'Value', 'Seconds'],
        numeric: [2, 3, 4],
        rows: rows(report.recorded.options)
      },
      { kind: 'heading', text: 'Simulated' },
      {
        kind: 'table',
        head: ['Plan', 'Id', 'Rate', 'Value', 'Seconds'],
        numeric: [2, 3, 4],
        rows: rows(report.simulated.options)
      }
    ]
  };
}
