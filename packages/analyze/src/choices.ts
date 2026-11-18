import { Database } from 'bun:sqlite';

import { type Block, type Cell, type Doc, link, num } from './doc';
import type { Lived } from './lived';
import type { RunLine, Runs } from './runs';

// Every decision the residents made over a span (the twelve hours before the history's newest
// event unless asked for more or less), with what woke it, where it stood, what it weighed, what it
// chose and what happened before the next; and each made again in order (runs.ts) to show whether
// it comes out the same.
const PAGE = 200;
const HOUR = 3_600_000;
const time = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');
// What follows a decision until the next: what it did and how its plans ended.
export const AFTER = [
  'acted',
  'executed',
  'plan-ended',
  'loop-broken',
  'loop-blocked',
  'narrated',
  'bound',
  'returning',
  'route-failed',
  'stranded',
  'died',
  'revived'
];

export const spanOf = (lived: Lived, hours?: number) => ({
  since: lived.newest - (hours && hours > 0 ? hours : 12) * HOUR,
  until: lived.newest
});

type Row = { id: number; at: number; kind: string; x: number | null; y: number | null; data: string };
export type Recorded = {
  trigger?: string;
  doing?: string;
  id?: string;
  rate?: number;
  ms?: number;
  kept?: boolean;
  keeping?: number;
  alternative?: { id?: string; key?: string; rate?: number };
  options?: { id: string; key: string; rate: number; blocked?: boolean }[];
};

export const chosen = (kind: string, d: Recorded) =>
  kind === 'considered'
    ? String(d.doing ?? '')
    : d.kept
      ? `kept ${d.id}`
      : `switched from ${d.id} to ${d.alternative?.key ?? d.alternative?.id ?? ''}`;

// A run's summary: how far it came and how much came out the same.
export function runSummary(lines: RunLine[]) {
  const decisions = lines.filter((l) => l.type === 'decision' && !l.untraced && !l.error);
  const start = lines.find((l) => l.type === 'start');
  const differs = decisions.find((l) => !l.same);
  const choiceDiffers = decisions.find((l) => sameChoice(l) === false);
  return {
    total: Number(start?.decisions ?? 0),
    made: decisions.length,
    same: decisions.filter((l) => l.same).length,
    sameChoice: decisions.filter((l) => sameChoice(l)).length,
    samePlace: decisions.filter((l) => samePlace(l)).length,
    differs: differs && Number(differs.id),
    choiceDiffers: choiceDiffers && Number(choiceDiffers.id),
    ended: lines.some((l) => l.type === 'end'),
    error: lines.find((l) => l.type === 'error')?.message as string | undefined
  };
}
export const sameChoice = (l: RunLine) => {
  const chose = l.chose as { live?: string; replay?: string } | undefined;
  return chose ? chose.live === chose.replay : undefined;
};
export const samePlace = (l: RunLine) => {
  const stood = l.stood as { live?: { x: number; y: number } | null; replay?: { x: number; y: number } | null };
  return stood?.live?.x === stood?.replay?.x && stood?.live?.y === stood?.replay?.y;
};

// A pull never changes: its counts per span are counted once.
const counted = new Map<string, Map<string, { considered: number; reconsidered: number }>>();

export function choicesDoc(lived: Lived, runs: Runs | undefined, hours?: number): Doc {
  const { since, until } = spanOf(lived, hours);
  const db = new Database(lived.file, { readonly: true });
  try {
    const key = `${lived.file} ${since} ${until}`;
    const counts = counted.get(key) ?? new Map<string, { considered: number; reconsidered: number }>();
    if (!counted.has(key))
      for (const r of db
        .query<{ resident: string; kind: string; n: number }, [number, number]>(
          "SELECT resident, kind, COUNT(*) AS n FROM events WHERE kind IN ('considered', 'reconsidered') AND at >= ? AND at <= ? GROUP BY resident, kind"
        )
        .all(since, until)) {
        const c = counts.get(r.resident) ?? { considered: 0, reconsidered: 0 };
        c[r.kind as 'considered' | 'reconsidered'] = r.n;
        counts.set(r.resident, c);
      }
    counted.set(key, counts);
    const span = hours ? `&hours=${hours}` : '';
    const residents = [...lived.residents.values()].filter((r) => counts.has(r.id));
    let running = false;
    const rows = residents.map((r): Cell[] => {
      const c = counts.get(r.id) ?? { considered: 0, reconsidered: 0 };
      const state = runs?.state(r.id);
      const s = runSummary(runs?.lines(r.id) ?? []);
      if (state && ['queued', 'fetching', 'running'].includes(state.status)) running = true;
      const status = state?.status ?? (s.made ? (s.ended ? 'done' : s.error ? 'failed' : 'stopped') : 'not run');
      return [
        { text: r.name, href: `/choices/${r.id}?page=0${span}` },
        num(c.considered),
        num(c.reconsidered),
        r.doing,
        {
          text: status,
          tone: status === 'failed' ? 'error' : status === 'done' ? 'good' : undefined,
          muted: state?.error
        },
        s.made ? `${s.made} of ${s.total}` : '',
        s.made ? { text: `${s.same}`, tone: s.same === s.made ? 'good' : 'error' } : '',
        s.made ? { text: `${s.sameChoice}`, tone: s.sameChoice === s.made ? 'good' : 'error' } : '',
        s.made ? `${s.samePlace}` : '',
        s.differs ? link(`#${s.differs}`, `/choice/${s.differs}`) : '',
        s.choiceDiffers ? link(`#${s.choiceDiffers}`, `/choice/${s.choiceDiffers}`) : ''
      ];
    });
    const q = hours ? `?hours=${hours}` : '';
    return {
      title: 'Choices',
      refresh: running ? 5 : undefined,
      subtitle: [
        `Every decision from ${time(since)} to ${time(until)} UTC`,
        ...[6, 12, 24].map((h) => (h === (hours ?? 12) ? `${h} h` : link(`${h} h`, `/choices?hours=${h}`)))
      ],
      blocks: [
        {
          kind: 'note',
          text: 'Run makes each resident’s decisions in this span again, in order, from the pull: its mind rebuilt from the waking the first began in, every event met as it was met live, on the clock it was met, with the encounter’s answers as given. Same weighing means every option it valued came to exactly the same value; same choice means it would have done the same; same place means its mind stood where it stood live.'
        },
        {
          kind: 'actions',
          items: [
            { label: 'Run all', post: `/runs/all${q}`, tone: 'primary' },
            ...(running ? [{ label: 'Stop all', post: '/runs/stop', tone: 'danger' as const }] : [])
          ]
        },
        {
          kind: 'table',
          head: [
            'Resident',
            'Choices',
            'Second thoughts',
            'Doing last',
            'Run',
            'Made again',
            'Same weighing',
            'Same choice',
            'Same place',
            'First weighing differing',
            'First choice differing'
          ],
          numeric: [1, 2],
          rows
        },
        {
          kind: 'actions',
          items: residents.map((r) => {
            const status = runs?.state(r.id)?.status;
            const busy = status === 'queued' || status === 'fetching' || status === 'running';
            return busy
              ? { label: `Stop ${r.name}`, post: `/runs/${r.id}/stop`, tone: 'danger' as const }
              : { label: `Run ${r.name}`, post: `/runs/${r.id}${q}` };
          })
        }
      ]
    };
  } finally {
    db.close();
  }
}

// One resident's decisions in the span, oldest first, a page at a time; `only=differs` keeps those
// the run made differently.
export function residentChoicesDoc(
  lived: Lived,
  runs: Runs | undefined,
  resident: string,
  page: number,
  hours?: number,
  only?: string
): Doc | undefined {
  const who = lived.residents.get(resident);
  if (!who) return undefined;
  const { since, until } = spanOf(lived, hours);
  const replayed = runs?.decisions(resident) ?? new Map<number, RunLine>();
  const db = new Database(lived.file, { readonly: true });
  try {
    const all = db
      .query<{ id: number; at: number }, [string, number, number]>(
        "SELECT id, at FROM events WHERE resident = ? AND kind IN ('considered', 'reconsidered') AND at >= ? AND at <= ? ORDER BY id"
      )
      .all(resident, since, until);
    const listed =
      only === 'differs'
        ? all.filter((d) => {
            const r = replayed.get(d.id);
            return r && (!r.same || sameChoice(r) === false);
          })
        : all;
    const pages = Math.max(1, Math.ceil(listed.length / PAGE));
    const at = Math.min(page, pages - 1);
    const shown = listed.slice(at * PAGE, (at + 1) * PAGE);
    const ids = shown.map((d) => d.id);
    const rows = ids.length
      ? db
          .query<Row, number[]>(
            `SELECT id, at, kind, x, y, data FROM events WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`
          )
          .all(...ids)
      : [];
    // Each shown decision's next, to bound what followed it.
    const index = new Map(all.map((d, i) => [d.id, i]));
    const nextOf = (id: number) => all[(index.get(id) ?? 0) + 1];
    const after = new Map<number, Map<string, number>>();
    const narrated = new Map<number, string>();
    if (rows.length) {
      const first = rows[0] as Row;
      const last = nextOf((rows.at(-1) as Row).id)?.at ?? until;
      const bounds = rows.map((r) => r.id);
      let b = 0;
      for (const e of db
        .query<{ id: number; kind: string; data: string }, (string | number)[]>(
          `SELECT id, kind, data FROM events WHERE resident = ? AND kind IN (${AFTER.map(() => '?').join(', ')}) AND at >= ? AND at <= ? ORDER BY id`
        )
        .all(resident, ...AFTER, first.at, last)) {
        while (b + 1 < bounds.length && e.id > (bounds[b + 1] as number)) b++;
        const owner = bounds[b] as number;
        if (e.id < owner || e.id > (nextOf(owner)?.id ?? Infinity)) continue;
        const d = JSON.parse(e.data) as Record<string, unknown>;
        const label =
          e.kind === 'acted'
            ? String(d.verb)
            : e.kind === 'plan-ended'
              ? `ended ${d.result}`
              : e.kind === 'executed'
                ? `executed ${d.succeeded ? 'ok' : 'failed'}`
                : e.kind === 'loop-broken' || e.kind === 'loop-blocked'
                  ? `${e.kind}: ${d.reason}`
                  : e.kind;
        if (e.kind === 'narrated') {
          if (typeof d.doing === 'string') narrated.set(owner, d.doing);
          continue;
        }
        const m = after.get(owner) ?? new Map<string, number>();
        m.set(label, (m.get(label) ?? 0) + 1);
        after.set(owner, m);
      }
    }
    const query = (p: number, o = only) =>
      `/choices/${resident}?page=${p}${hours ? `&hours=${hours}` : ''}${o ? `&only=${o}` : ''}`;
    const s = runSummary(runs?.lines(resident) ?? []);
    const blocks: Block[] = [
      {
        kind: 'fields',
        rows: [
          ['Span', `${time(since)} to ${time(until)} UTC`],
          ['Decisions', num(all.length)],
          ['Doing last', who.doing],
          ['Why last', who.why],
          [
            'Run',
            s.made
              ? `${s.made} of ${s.total} made again: ${s.same} same weighing, ${s.sameChoice} same choice, ${s.samePlace} same place${s.ended ? '' : ' (not finished)'}`
              : 'not run'
          ]
        ]
      },
      {
        kind: 'actions',
        items: [
          { label: `Run ${who.name}`, post: `/runs/${resident}${hours ? `?hours=${hours}` : ''}`, tone: 'primary' }
        ]
      },
      ...wakings(runs?.lines(resident) ?? []),
      { kind: 'heading', text: 'Decisions (oldest first, UTC)' },
      {
        kind: 'table',
        head: [
          'When',
          'Decision',
          'Kind',
          'Woken by',
          'Where',
          'Chose',
          'Rate',
          'Weighed (rate, ✕ blocked)',
          'Then',
          'Made again'
        ],
        numeric: [6],
        empty: only ? 'None made differently.' : 'No decisions in this span.',
        rows: rows.map((r): Cell[] => {
          const d = JSON.parse(r.data) as Recorded;
          const replay = replayed.get(r.id);
          const options =
            r.kind === 'considered'
              ? (d.options ?? []).map((o) => `${o.blocked ? '✕ ' : ''}${o.key} ${o.rate.toFixed(2)}`).join(' · ')
              : `${d.alternative?.key ?? ''} ${d.alternative?.rate?.toFixed(2) ?? ''} vs keeping ${d.keeping?.toFixed(2) ?? ''}`;
          const then = [...(after.get(r.id) ?? [])].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
          return [
            { text: time(r.at), sort: r.at },
            link(`#${r.id}`, `/choice/${r.id}`),
            r.kind,
            String(d.trigger || 'start'),
            r.x === null ? '' : `${r.x},${r.y}`,
            chosen(r.kind, d),
            typeof d.rate === 'number' ? Number(d.rate.toFixed(3)) : (d.keeping ?? null),
            options,
            { text: then, muted: narrated.get(r.id) },
            replay ? replayCell(replay) : ''
          ];
        })
      }
    ];
    return {
      title: `Choices of ${who.name}`,
      refresh: ['queued', 'fetching', 'running'].includes(runs?.state(resident)?.status ?? '') ? 10 : undefined,
      subtitle: [
        link('all residents', `/choices${hours ? `?hours=${hours}` : ''}`),
        link('trace', `/trace/${resident}`),
        only ? link('every decision', query(0, '')) : link('only those made differently', query(0, 'differs')),
        at > 0 ? link('first', query(0)) : 'first',
        at > 0 ? link('earlier', query(at - 1)) : 'earlier',
        `page ${at + 1} of ${pages}`,
        at < pages - 1 ? link('later', query(at + 1)) : 'later',
        at < pages - 1 ? link('last', query(pages - 1)) : 'last'
      ],
      blocks
    };
  } finally {
    db.close();
  }
}

// How the run woke the mind each time the live one woke: the first from its kept checkpoint or from
// birth, each later one from its kept checkpoint (with how the run's own mind differed from it) or
// from the run's own mind where the live one checkpointed. From birth where live restored a checkpoint
// no longer kept, the run starts from a mind that may not be the one it had.
function wakings(lines: RunLine[]): Block[] {
  const woke = lines.filter((l) => l.type === 'wake');
  if (!woke.length) return [];
  const how = (l: RunLine): Cell =>
    l.mode === 'checkpoint'
      ? 'from its kept checkpoint'
      : l.mode === 'carried'
        ? 'from the run’s own mind'
        : Number(l.after) > 0
          ? { text: 'from birth: the checkpoint it restored live is no longer kept', tone: 'error' }
          : 'from birth, as live';
  return [
    { kind: 'heading', text: 'Wakings in the run' },
    {
      kind: 'table',
      head: [
        'Waking',
        'Woke (UTC)',
        'Woken',
        'Checkpoint through',
        'Re-lived through',
        'Events re-lived',
        'Own mind differing from the kept checkpoint',
        'Took (ms)'
      ],
      numeric: [3, 4, 5, 7],
      rows: woke.map((l): Cell[] => {
        const differs = (l.differs as string[] | undefined) ?? [];
        return [
          String(l.wake),
          time(Number(l.at)),
          how(l),
          Number(l.after),
          Number(l.through),
          Number(l.relived),
          l.differs === undefined
            ? ''
            : differs.length
              ? {
                  text: `${differs.length}${differs.length > 40 ? '+' : ''} parts`,
                  tone: 'error',
                  muted: differs.slice(0, 3).join('; ')
                }
              : { text: 'none', tone: 'good' },
          Number(l.ms)
        ];
      })
    }
  ];
}

export function replayCell(l: RunLine): Cell {
  if (l.untraced) return 'not traced';
  if (l.error) return { text: String(l.error), tone: 'error' };
  const chose = l.chose as { replay?: string };
  if (l.same) return { text: '✓ same', tone: 'good', muted: samePlace(l) ? undefined : 'stood elsewhere' };
  return sameChoice(l)
    ? { text: '≈ weighed differently, same choice', tone: 'error' }
    : { text: `✗ ${chose.replay ?? ''}`, tone: 'error' };
}
