import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Block, type Cell, type Doc, link, noDatabase, num } from './doc';

// Every question the residents asked (packages/ai/src/decision-log.ts): when, who, its kind, the
// options offered and the answer, from Clef, Jev or the local rules. One question's page has its
// whole context: the state, the instructions and the full response.
const PAGE = 500;
interface Row {
  id: string;
  at: number;
  name: string | null;
  kind: string;
  source: string;
  reason: string;
  provider: string;
  model: string;
  selected: string | null;
  baseline: string;
  request: Uint8Array<ArrayBuffer>;
  response: Uint8Array<ArrayBuffer>;
}
const unzip = (bytes: Uint8Array<ArrayBuffer>) => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
interface Attempt {
  provider: string;
  model: string;
  reason: string;
  latencyMs: number;
  wire?: { url: string; sent: string; encoding?: string; bytes?: number; status?: number; received?: string };
}
// A JSON body laid out for reading; anything else as it came.
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const time = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');

function open(saves: string) {
  const file = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  const logged = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_log'").get();
  if (logged) return db;
  db.close();
  return null;
}
const unlogged: Doc = {
  title: 'Questions',
  blocks: [{ kind: 'note', text: 'This pull was taken before residents logged their questions.' }]
};
const SELECT = `SELECT d.*, r.proposed_name AS name FROM decision_log d LEFT JOIN residents r ON r.id = d.resident_id`;

export function questionsDoc(saves: string, page: number): Doc {
  const db = open(saves);
  if (db === undefined) return noDatabase('Questions');
  if (db === null) return unlogged;
  try {
    const total = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM decision_log').get()?.n ?? 0;
    const providers = db
      .query<{ provider: string; n: number }, []>(
        'SELECT provider, COUNT(*) AS n FROM decision_log GROUP BY provider ORDER BY n DESC'
      )
      .all();
    const rows = db
      .query<Row, [number, number]>(`${SELECT} ORDER BY d.at DESC LIMIT ? OFFSET ?`)
      .all(PAGE, page * PAGE);
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const nav: Cell[] = [
      page > 0 ? link('newer', `/questions?page=${page - 1}`) : 'newer',
      `page ${page + 1} of ${pages}`,
      page + 1 < pages ? link('older', `/questions?page=${page + 1}`) : 'older'
    ];
    const pager: Block = { kind: 'table', head: ['', '', ''], rows: [nav] };
    return {
      title: 'Questions',
      subtitle: [`${total} asked`, ...providers.map((p) => `${p.n} answered by ${p.provider}`)],
      blocks: [
        pager,
        {
          kind: 'table',
          head: ['When', 'Resident', 'Kind', 'Options', 'Answered by', 'Answer', 'Local rules', 'Confidence', 'Reason'],
          interactive: true,
          empty: 'No questions logged yet.',
          rows: rows.map((r) => {
            const request = unzip(r.request);
            const response = unzip(r.response);
            const options = Object.keys(request.questions?.action?.criteria ?? {});
            return [
              { text: time(r.at), href: `/question/${r.id}`, sort: r.at },
              r.name ?? r.id,
              r.kind,
              options.join(', '),
              r.provider === 'local' ? 'local' : `${r.provider} ${r.model}`,
              r.selected ?? '—',
              r.baseline,
              response.confidence === undefined ? null : num(response.confidence, 2),
              r.reason
            ];
          })
        },
        pager
      ]
    };
  } finally {
    db.close();
  }
}

export function questionDoc(saves: string, id: string): Doc | undefined {
  const db = open(saves);
  if (db === undefined) return noDatabase('Question');
  if (db === null) return unlogged;
  try {
    const r = db.query<Row, [string]>(`${SELECT} WHERE d.id = ?`).get(id);
    if (!r) return undefined;
    const request = unzip(r.request);
    const response = unzip(r.response);
    const action = request.questions?.action ?? {};
    return {
      title: `${r.kind} question`,
      subtitle: [time(r.at), r.name ?? r.id],
      blocks: [
        {
          kind: 'fields',
          rows: [
            ['Kind', r.kind],
            ['Question type', action.type ?? null],
            ['Answered by', r.provider === 'local' ? 'local rules' : `${r.provider} ${r.model}`],
            ['Answer', r.selected ?? '—'],
            ['Local rules', r.baseline],
            ['Confidence', response.confidence === undefined ? null : num(response.confidence, 2)],
            ['Source / reason', `${r.source} / ${r.reason}`],
            ['Latency', `${response.latencyMs ?? 0} ms`]
          ]
        },
        { kind: 'heading', text: 'Options' },
        {
          kind: 'table',
          head: ['Option', 'Description', 'Probability'],
          rows: Object.entries(action.criteria ?? {}).map(([option, description]) => [
            option,
            String(description),
            response.probabilities?.[option] === undefined ? null : num(response.probabilities[option], 3)
          ])
        },
        { kind: 'heading', text: 'Instructions' },
        { kind: 'pre', text: String(action.instructions ?? '') },
        { kind: 'heading', text: 'Context (state sent with the question)' },
        { kind: 'pre', text: JSON.stringify(request.state, null, 2) },
        // Exactly what went over the wire to each provider asked, and what came back.
        ...(response.attempts ?? []).flatMap((attempt: Attempt): Block[] => [
          { kind: 'heading', text: `${attempt.provider} ${attempt.model}: ${attempt.reason}, ${attempt.latencyMs} ms` },
          ...(attempt.wire
            ? ([
                {
                  kind: 'fields',
                  rows: [
                    ['URL', attempt.wire.url],
                    ['HTTP status', attempt.wire.status ?? null],
                    [
                      'Sent as',
                      attempt.wire.encoding
                        ? `${attempt.wire.encoding}-compressed, ${attempt.wire.bytes} bytes on the wire (shown decompressed)`
                        : 'plain text'
                    ]
                  ]
                },
                { kind: 'heading', text: 'Sent' },
                { kind: 'pre', text: pretty(attempt.wire.sent) },
                { kind: 'heading', text: 'Received' },
                { kind: 'pre', text: attempt.wire.received === undefined ? '(nothing)' : pretty(attempt.wire.received) }
              ] as Block[])
            : [{ kind: 'note', text: 'No exchange recorded for this attempt.' } as Block])
        ]),
        { kind: 'heading', text: 'Response as recorded' },
        { kind: 'pre', text: JSON.stringify(response, null, 2) }
      ]
    };
  } finally {
    db.close();
  }
}
