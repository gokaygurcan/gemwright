import { type Cell, type Doc, type FlowStep, link, noDatabase } from './doc';
import { open, type Row, SELECT, time, unzip } from './questions';

// Each decision a resident made, drawn as a flowchart: what it started from, every check and fork
// on the way with the weights of all options, and where it ended (packages/ai/src/decision-flow.ts).
const PAGE = 500;
const unlogged: Doc = {
  title: 'Decisions',
  blocks: [{ kind: 'note', text: 'This pull was taken before residents logged their decisions.' }]
};
const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);

export function decisionsDoc(saves: string, page: number, kind?: string): Doc {
  const db = open(saves);
  if (db === undefined) return noDatabase('Decisions');
  if (db === null) return unlogged;
  try {
    const kinds = db
      .query<{ kind: string; n: number }, []>(
        'SELECT kind, COUNT(*) AS n FROM decision_log GROUP BY kind ORDER BY n DESC'
      )
      .all();
    const where = kind ? 'WHERE d.kind = ?' : 'WHERE ? IS NULL';
    const total = kinds.filter((k) => !kind || k.kind === kind).reduce((n, k) => n + k.n, 0);
    const rows = db
      .query<Row, [string | null, number, number]>(`${SELECT} ${where} ORDER BY d.at DESC LIMIT ? OFFSET ?`)
      .all(kind ?? null, PAGE, page * PAGE);
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const at = (p: number) => `/decisions?${kind ? `kind=${encodeURIComponent(kind)}&` : ''}page=${p}`;
    const nav: Cell[] = [
      page > 0 ? link('newer', at(page - 1)) : 'newer',
      `page ${page + 1} of ${pages}`,
      page + 1 < pages ? link('older', at(page + 1)) : 'older'
    ];
    return {
      title: 'Decisions',
      subtitle: [
        kind ? link('all kinds', '/decisions') : 'all kinds',
        ...kinds.map((k) =>
          k.kind === kind ? `${k.kind} (${k.n})` : link(`${k.kind} (${k.n})`, `/decisions?kind=${k.kind}`)
        )
      ],
      blocks: [
        { kind: 'table', head: ['', '', ''], rows: [nav] },
        {
          kind: 'table',
          head: ['When', 'Resident', 'Kind', 'Local rules', 'Ended at', 'Decided by', 'Steps'],
          interactive: true,
          empty: 'No decisions logged yet.',
          rows: rows.map((r) => {
            const steps = (unzip(r.response).flow ?? []) as FlowStep[];
            return [
              { text: time(r.at), href: `/decision/${r.id}`, sort: r.at },
              r.name ?? r.id,
              r.kind,
              r.baseline,
              r.selected ?? '—',
              r.provider === 'local' ? `local (${r.reason})` : `${r.provider} ${r.model}`,
              steps.length || '—'
            ];
          })
        }
      ]
    };
  } finally {
    db.close();
  }
}

export function decisionDoc(saves: string, id: string): Doc | undefined {
  const db = open(saves);
  if (db === undefined) return noDatabase('Decision');
  if (db === null) return unlogged;
  try {
    const r = db.query<Row, [string]>(`${SELECT} WHERE d.id = ?`).get(id);
    if (!r) return undefined;
    const request = unzip(r.request);
    const response = unzip(r.response);
    const steps = (response.flow ?? []) as FlowStep[];
    const situation = Object.entries((request.state ?? {}) as Record<string, unknown>)
      .filter(([, v]) => scalar(v))
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return {
      title: `${r.kind} decision`,
      subtitle: [time(r.at), r.name ?? r.id, link('full question', `/question/${r.id}`)],
      blocks: steps.length
        ? [
            {
              kind: 'flow',
              start: { label: `${r.name ?? 'Resident'} decides ${r.kind}`, detail: situation || undefined },
              steps,
              end: {
                label: r.selected ? `Ended at ${r.selected}` : 'Ended with nothing: the situation changed',
                detail: `${r.source === 'model' ? `Decided by ${r.provider} ${r.model}` : 'Decided by the local rules'}${
                  r.selected && r.selected !== r.baseline ? `; the local rules said ${r.baseline}` : ''
                }`
              }
            }
          ]
        : [{ kind: 'note', text: 'This decision was logged before decisions recorded their path.' }]
    };
  } finally {
    db.close();
  }
}
