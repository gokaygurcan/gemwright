import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Block, type Cell, type Doc, num } from './doc';

// The v2 minds (packages/ai/src/v2): each resident's traits, how often what it would have chosen
// agrees with what it did, its latest choices beside the alternative it valued most, what each kind
// of attempt has brought, how far its predictions miss over time, which spawners bear out what
// they spawn, and how long each kind of thing stays where it was seen.
export function mindsDoc(saves: string): Doc {
  const file = join(saves, '../../ai/history.sqlite');
  if (!existsSync(file)) return { title: 'Minds', blocks: [{ kind: 'note', text: 'This pull has no v2 history.' }] };
  const db = new Database(file, { readonly: true });
  const names = residentNames(join(saves, '../../ai/residents.sqlite'));
  try {
    const residents = db
      .query<{ resident: string; n: number; last: number }, []>(
        'SELECT resident, COUNT(*) AS n, MAX(at) AS last FROM events GROUP BY resident ORDER BY last DESC'
      )
      .all();
    const blocks: Block[] = [];
    for (const r of residents) blocks.push(...mind(db, r.resident, names.get(r.resident), r.n, r.last));
    return { title: 'Minds', blocks: blocks.length ? blocks : [{ kind: 'note', text: 'No resident has lived yet.' }] };
  } finally {
    db.close();
  }
}

function residentNames(file: string) {
  if (!existsSync(file)) return new Map<string, string>();
  const db = new Database(file, { readonly: true });
  try {
    return new Map(
      db
        .query<{ id: string; name: string }, []>('SELECT id, proposed_name AS name FROM residents')
        .all()
        .map((r) => [r.id, r.name])
    );
  } finally {
    db.close();
  }
}

const when = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');

function mind(db: Database, resident: string, name: string | undefined, events: number, last: number): Block[] {
  const rows = <T>(sql: string, ...args: (string | number)[]) => db.query<T, (string | number)[]>(sql).all(...args);
  const born = rows<{ data: string }>(
    "SELECT data FROM events WHERE resident = ? AND kind = 'born' LIMIT 1",
    resident
  )[0];
  const traits = born ? (JSON.parse(born.data) as { traits: Record<string, number> }).traits : {};
  // Each trait as it is now: the last it drifted to, else as born.
  const now = new Map(
    rows<{ trait: string; to: number }>(
      `SELECT json_extract(data, '$.trait') AS trait, json_extract(data, '$.to') AS "to" FROM events
      WHERE id IN (SELECT MAX(id) FROM events WHERE resident = ? AND kind = 'drifted' GROUP BY json_extract(data, '$.trait'))`,
      resident
    ).map((d) => [d.trait, d.to])
  );
  const agreement = rows<{ n: number; agrees: number | null }>(
    "SELECT COUNT(*) AS n, SUM(json_extract(data, '$.agrees')) AS agrees FROM events WHERE resident = ? AND kind = 'considered'",
    resident
  )[0] ?? { n: 0, agrees: 0 };
  const choices = rows<{ at: number; data: string }>(
    "SELECT at, data FROM events WHERE resident = ? AND kind = 'considered' ORDER BY id DESC LIMIT 25",
    resident
  ).map((r) => {
    const d = JSON.parse(r.data) as { doing: string; choice?: string; agrees: boolean; options: { value: number }[] };
    return [
      when(r.at),
      d.doing,
      { text: d.choice ?? '', ...(d.agrees ? { tone: 'good' as const } : {}) },
      num(d.options[0]?.value ?? 0, 1)
    ] as Cell[];
  });
  const attempts = rows<{ key: string; n: number; seconds: number; health: number; skill: number; died: number }>(
    `SELECT json_extract(data, '$.key') AS key, COUNT(*) AS n, AVG(json_extract(data, '$.observed.seconds')) AS seconds,
      AVG(json_extract(data, '$.observed.health')) AS health, AVG(json_extract(data, '$.observed.skill')) AS skill,
      SUM(json_extract(data, '$.observed.died')) AS died
    FROM events WHERE resident = ? AND kind = 'outcome' GROUP BY key ORDER BY n DESC LIMIT 40`,
    resident
  ).map((a) => [a.key, num(a.n), num(a.seconds, 1), num(a.health, 1), num(a.skill, 2), num(a.died)] as Cell[]);
  // How far its predictions missed, day by day: falling misses mean it is learning.
  const misses = rows<{ day: string; n: number; seconds: number; health: number; died: number; gold: number }>(
    `SELECT date(at / 1000, 'unixepoch') AS day, COUNT(*) AS n,
      AVG(ABS(json_extract(data, '$.error.seconds'))) AS seconds, AVG(ABS(json_extract(data, '$.error.health'))) AS health,
      AVG(ABS(json_extract(data, '$.error.died'))) AS died,
      AVG(ABS(COALESCE(json_extract(data, '$.error.gained.Gold'), 0) - COALESCE(json_extract(data, '$.error.lost.Gold'), 0))) AS gold
    FROM events WHERE resident = ? AND kind = 'outcome' AND json_extract(data, '$.error') IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT 30`,
    resident
  ).map((m) => [m.day, num(m.n), num(m.seconds, 1), num(m.health, 1), num(m.died, 3), num(m.gold, 1)] as Cell[]);
  // The spawners it has passed, and how often it found what they spawn there.
  const places = rows<{ x: number; y: number; kinds: string; visits: number; finds: number }>(
    `SELECT json_extract(data, '$.x') AS x, json_extract(data, '$.y') AS y, json_extract(data, '$.kinds') AS kinds,
      COUNT(*) AS visits, SUM(json_extract(data, '$.found')) AS finds
    FROM events WHERE resident = ? AND kind = 'visited' GROUP BY x, y, kinds ORDER BY visits DESC LIMIT 40`,
    resident
  ).map(
    (p) =>
      [
        `${p.x}, ${p.y}`,
        (JSON.parse(p.kinds) as string[]).join(', '),
        num(p.visits),
        num(p.finds),
        num((p.finds + 1) / (p.visits + 2), 2)
      ] as Cell[]
  );
  const lifetimes = rows<{ name: string; watched: number; endings: number }>(
    `SELECT j.key AS name, SUM(json_extract(j.value, '$.watched')) AS watched, SUM(json_extract(j.value, '$.endings')) AS endings
    FROM events, json_each(events.data) AS j WHERE resident = ? AND kind = 'lifetimes'
    GROUP BY name ORDER BY watched / (endings + 1) DESC LIMIT 40`,
    resident
  ).map((l) => [l.name, num(l.watched / (l.endings + 1) / 60, 1), num(l.endings)] as Cell[]);
  return [
    { kind: 'heading', text: name ?? resident },
    {
      kind: 'fields',
      rows: [
        ['Events', num(events)],
        ['Last perceived', when(last)],
        ['Agrees with what it did', `${agreement.agrees ?? 0} of ${agreement.n} choices`],
        ...Object.entries(traits).map(
          ([trait, value]) =>
            [trait, now.has(trait) ? `${now.get(trait)?.toFixed(2)} (born ${value.toFixed(2)})` : num(value, 2)] as [
              string,
              Cell
            ]
        )
      ]
    },
    {
      kind: 'table',
      head: ['When', 'What it did', 'What it would have done', 'Worth'],
      rows: choices,
      numeric: [3],
      empty: 'No choices weighed yet.'
    },
    {
      kind: 'table',
      head: ['Attempt', 'Times', 'Seconds', 'Health', 'Skill', 'Deaths'],
      rows: attempts,
      numeric: [1, 2, 3, 4, 5],
      interactive: true,
      empty: 'No attempts yet.'
    },
    {
      kind: 'table',
      head: ['Day', 'Predicted', 'Seconds off', 'Health off', 'Death off', 'Gold off'],
      rows: misses,
      numeric: [1, 2, 3, 4, 5],
      empty: 'No predictions checked yet.'
    },
    {
      kind: 'table',
      head: ['Spawner', 'Spawns', 'Passed', 'Found', 'Trust'],
      rows: places,
      numeric: [2, 3, 4],
      interactive: true,
      empty: 'No spawners passed yet.'
    },
    {
      kind: 'table',
      head: ['Kind of thing', 'Stays (minutes)', 'Seen leave'],
      rows: lifetimes,
      numeric: [1, 2],
      interactive: true,
      empty: 'No lifetimes learned yet.'
    }
  ];
}
