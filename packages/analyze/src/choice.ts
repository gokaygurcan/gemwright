import { Database } from 'bun:sqlite';

import { chosen, type Recorded, replayCell, sameChoice, samePlace } from './choices';
import { type Block, type Cell, type Doc, link } from './doc';
import type { Lived } from './lived';
import type { Runs } from './runs';
import { summary } from './trace';

// One decision whole: what it knew (everything it met since its previous decision, what it met while
// weighing, itself as last perceived, the encounter's answers and the clock), what it weighed and
// chose, everything that happened until its next decision, and how it came out made again (runs.ts).
const LIMIT = 2000;
const time = (at: number) => new Date(at).toISOString().slice(11, 23);
type Row = {
  id: number;
  resident: string;
  at: number;
  kind: string;
  x: number | null;
  y: number | null;
  via: string | null;
  data: string;
};
type Trace = {
  from: number;
  now: number;
  slices: [number, number, number][];
  tape: [string, unknown][];
  digest?: string;
  active?: unknown;
};
const round = (n: unknown, digits = 3) => (typeof n === 'number' ? Number(n.toFixed(digits)) : null);

export function choiceDoc(lived: Lived, runs: Runs | undefined, id: number): Doc | undefined {
  const db = new Database(lived.file, { readonly: true });
  try {
    const row = db.query<Row, [number]>('SELECT * FROM events WHERE id = ?').get(id);
    if (!row || (row.kind !== 'considered' && row.kind !== 'reconsidered')) return undefined;
    const d = JSON.parse(row.data) as Record<string, unknown> & { trace?: Trace };
    const trace = d.trace;
    const who = lived.residents.get(row.resident);
    // By time, as the history's index runs; the nearer of a choice and a second thought.
    const neighbour = (op: '<' | '>') => {
      const order = op === '<' ? 'DESC' : 'ASC';
      const found = ['considered', 'reconsidered'].flatMap(
        (kind) =>
          db
            .query<Row, [string, string, number, number]>(
              `SELECT * FROM events WHERE resident = ? AND kind = ? AND at ${op}= ? AND id ${op} ? ORDER BY at ${order}, id ${order} LIMIT 1`
            )
            .get(row.resident, kind, row.at, id) ?? []
      );
      return found.sort((a, b) => (op === '<' ? b.id - a.id : a.id - b.id))[0];
    };
    const previous = neighbour('<');
    const next = neighbour('>');
    const before = previous && (JSON.parse(previous.data) as { trace?: Trace }).trace;
    const events = (after: number, through: number) =>
      db
        .query<Row, [string, number, number]>(
          `SELECT * FROM events WHERE +resident = ? AND id > ? AND id <= ? ORDER BY id LIMIT ${LIMIT + 1}`
        )
        .all(row.resident, after, through);
    const table = (rows: Row[], empty: string): Block => ({
      kind: 'table',
      head: ['Event', 'Time', 'Kind', 'Via', 'Where', 'What'],
      interactive: true,
      empty,
      rows: rows
        .slice(0, LIMIT)
        .map((e): Cell[] => [
          link(
            String(e.id),
            e.kind === 'considered' || e.kind === 'reconsidered' ? `/choice/${e.id}` : `/event/${e.id}`
          ),
          time(e.at),
          e.kind,
          e.via ?? '',
          e.x === null ? '' : `${e.x},${e.y}`,
          summary(e.kind, e.data)
        ])
    });
    const more = (rows: Row[], after: number): Block[] =>
      rows.length > LIMIT
        ? [{ kind: 'note', text: `Only the first ${LIMIT} are shown; the rest are in the trace from event ${after}.` }]
        : [];
    const traits = (d.traits ?? lastTraits(db, row.resident, id, row.at)) as Record<string, number> | undefined;
    const replay = runs?.decisions(row.resident).get(id);
    const blocks: Block[] = [
      {
        kind: 'fields',
        rows: [
          ['Resident', who ? link(who.name, `/choices/${row.resident}`) : row.resident],
          ['When', `${new Date(row.at).toISOString()}`],
          ['Kind', row.kind === 'considered' ? 'choice' : 'second thought on the way'],
          ['Woken by', String(d.trigger || 'start')],
          ['Where it stood', row.x === null ? '' : `${row.x},${row.y}`],
          ['Thought for', `${d.ms} ms`],
          ['Chose', chosen(row.kind, d as Recorded)],
          ...(row.kind === 'considered'
            ? ([
                ['Plan', String(d.id ?? 'none')],
                ['Steps', JSON.stringify(d.steps ?? [])],
                ['Value', round(d.value)],
                ['Rate', round(d.rate)],
                ['Seconds', round(d.seconds, 1)],
                ['Urgent', String(d.urgent)],
                ['Funding', d.funding === undefined ? '' : JSON.stringify(d.funding)],
                ['Guarded', String(d.guarded)]
              ] as [string, Cell][])
            : ([
                ['Plan under way', String(d.id)],
                ['Its rate now', round(d.keeping)],
                ['Best other', d.alternative ? JSON.stringify(d.alternative) : 'none'],
                ['Patience', round(traits?.patience)],
                ['Kept', String(d.kept)]
              ] as [string, Cell][])),
          ['Weighing digest', trace?.digest ?? 'not traced']
        ]
      }
    ];
    if (row.kind === 'considered')
      blocks.push(
        { kind: 'heading', text: 'What it weighed (the five it recorded)' },
        {
          kind: 'table',
          head: ['Option', 'Id', 'Value', 'Rate', 'Seconds', 'Blocked'],
          numeric: [2, 3, 4],
          rows: ((d.options ?? []) as Record<string, unknown>[]).map((o) => [
            String(o.key),
            String(o.id),
            round(o.value, 2),
            round(o.rate, 4),
            round(o.seconds, 1),
            o.blocked ? 'blocked (loop breaker)' : ''
          ])
        }
      );
    blocks.push({ kind: 'heading', text: 'Made again' });
    if (!replay) blocks.push({ kind: 'note', text: 'Not made again yet: run this resident on the Choices page.' });
    else {
      const stood = replay.stood as { live?: unknown; replay?: unknown };
      const chose = replay.chose as { live?: string; replay?: string };
      blocks.push(
        {
          kind: 'fields',
          rows: [
            ['Result', replayCell(replay)],
            ['Same weighing', String(replay.same)],
            ['Same choice', String(sameChoice(replay))],
            ['Same place', String(samePlace(replay))],
            ['Chose live', chose.live ?? ''],
            ['Chose made again', chose.replay ?? ''],
            ['Stood live as it began weighing', JSON.stringify(stood.live)],
            ['Stood made again as it began weighing', JSON.stringify(stood.replay)],
            ['Digest made again', String((replay.digest as { replay?: string })?.replay ?? '')],
            ['Options valued', String(replay.count ?? '')],
            ['Began while an earlier weighing was under way', String(replay.overlap)],
            ['Questions never asked live', ((replay.unanswered as string[]) ?? []).join(', ') || 'none'],
            ['Waking', String(replay.wake ?? '')],
            ['Took', `${replay.ms} ms`]
          ]
        },
        {
          kind: 'table',
          head: ['Option made again', 'Id', 'Value', 'Rate', 'Seconds', 'Urgent'],
          numeric: [2, 3, 4],
          rows: ((replay.options as Record<string, unknown>[]) ?? []).map((o) => [
            String(o.key),
            String(o.id),
            round(o.value, 2),
            round(o.rate, 4),
            round(o.seconds, 1),
            o.urgent ? 'urgent' : ''
          ])
        }
      );
    }
    if (traits)
      blocks.push(
        { kind: 'heading', text: 'Its traits' },
        { kind: 'fields', rows: Object.entries(traits).map(([k, v]): [string, Cell] => [k, round(v)]) }
      );
    if (trace) {
      const self = db
        .query<{ id: number; at: number; data: string }, [string, number, number]>(
          "SELECT id, at, data FROM events WHERE resident = ? AND kind = 'self' AND at <= ? AND id <= ? ORDER BY at DESC, id DESC LIMIT 1"
        )
        .get(row.resident, trace.now, trace.from);
      const knew = events(before?.from ?? previous?.id ?? trace.from - 1, trace.from);
      const marks = trace.slices.map((s) => s[1]);
      const during = events(trace.from, Math.max(trace.from, ...marks));
      const answers = new Map<string, number>();
      for (const [question, answer] of trace.tape) {
        const key = `${question}\u0000${JSON.stringify(answer)}`;
        answers.set(key, (answers.get(key) ?? 0) + 1);
      }
      blocks.push(
        { kind: 'heading', text: 'What it knew: new since its previous decision' },
        {
          kind: 'note',
          text: `Everything it met after ${before ? `event ${before.from}, where its previous decision began` : 'its previous decision'}, up to event ${trace.from}, where this one began. All before is in its trace.`
        },
        table(knew, 'Nothing new.'),
        ...more(knew, before?.from ?? 0),
        { kind: 'heading', text: 'What it met while weighing' },
        table(during, 'Nothing.'),
        { kind: 'heading', text: 'Itself, as last perceived' },
        {
          kind: 'pre',
          text: self
            ? `event ${self.id} at ${time(self.at)}\n${JSON.stringify(JSON.parse(self.data), null, 2)}`
            : 'Never perceived.'
        },
        { kind: 'heading', text: 'What the encounter answered' },
        {
          kind: 'table',
          head: ['Question', 'Answer', 'Times'],
          numeric: [2],
          interactive: true,
          empty: 'Nothing was asked.',
          rows: [...answers].map(([key, n]) => {
            const [question, answer] = key.split('\u0000');
            return [question ?? '', (answer ?? '').slice(0, 400), n];
          })
        },
        { kind: 'heading', text: 'Its clock' },
        {
          kind: 'table',
          head: ['Steps weighed', 'Events met through', 'Then (UTC)'],
          numeric: [0, 1],
          rows: [[0, trace.from, time(trace.now)], ...trace.slices.map(([s, m, at]): Cell[] => [s, m, time(at)])]
        }
      );
      if (trace.active)
        blocks.push(
          { kind: 'heading', text: 'The plan it weighed against' },
          { kind: 'pre', text: JSON.stringify(trace.active, null, 2) }
        );
    }
    const then = events(id, next ? next.id - 1 : Number.MAX_SAFE_INTEGER);
    blocks.push(
      { kind: 'heading', text: next ? 'What happened until its next decision' : 'What happened after' },
      table(then, 'Nothing.'),
      ...more(then, id)
    );
    return {
      title: `${who?.name ?? row.resident.slice(0, 8)}: ${row.kind === 'considered' ? 'choice' : 'second thought'} #${id}`,
      subtitle: [
        previous ? link('← previous decision', `/choice/${previous.id}`) : 'first decision',
        next ? link('next decision →', `/choice/${next.id}`) : 'last decision',
        link('all its decisions', `/choices/${row.resident}`),
        link('trace to here', `/trace/${row.resident}?before=${id + 1}`),
        link('raw event', `/event/${id}`),
        ...(trace ? [link('simulate in the AI service', `/simulate/${id}`)] : [])
      ],
      blocks
    };
  } finally {
    db.close();
  }
}

// A second thought does not record the traits it weighed with: those of the choice before it.
function lastTraits(db: Database, resident: string, id: number, at: number) {
  const row = db
    .query<{ data: string }, [string, number, number]>(
      "SELECT json_extract(data, '$.traits') AS data FROM events WHERE resident = ? AND kind = 'considered' AND at <= ? AND id < ? ORDER BY at DESC, id DESC LIMIT 1"
    )
    .get(resident, at, id);
  return row?.data ? (JSON.parse(row.data) as Record<string, number>) : undefined;
}
