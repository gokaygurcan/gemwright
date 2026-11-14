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
      COUNT(*) AS visits,
      SUM(CASE WHEN json_type(data, '$.found') = 'array' THEN json_array_length(data, '$.found') > 0
        ELSE json_extract(data, '$.found') END) AS finds
    FROM events WHERE resident = ? AND kind = 'visited' GROUP BY x, y, kinds ORDER BY visits DESC LIMIT 40`,
    resident
  ).map(
    (p) =>
      [
        `${p.x}, ${p.y}`,
        (JSON.parse(p.kinds) as string[]).join(', '),
        num(p.visits),
        num(p.finds),
        num(p.finds / p.visits, 2)
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
    ...perception(db, resident),
    {
      kind: 'fields',
      rows: [
        ['Events', { ...(num(events) as { text: string }), href: `/trace/${resident}` }],
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
      head: ['Spawner', 'Spawns', 'Passed', 'Found', 'Found share'],
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

// What it knows at once (packages/ai/src/v2): where it is, what it is and what it has, as last
// written down.
function perception(db: Database, resident: string): Block[] {
  const latest = <T>(kind: string) => {
    const row = db
      .query<{ data: string }, [string, string]>(
        'SELECT data FROM events WHERE resident = ? AND kind = ? ORDER BY id DESC LIMIT 1'
      )
      .get(resident, kind);
    return row ? (JSON.parse(row.data) as T) : undefined;
  };
  const place = latest<{
    regions: string[];
    kind: string;
    guarded: boolean;
    island?: string;
    dungeon?: string;
    level?: number;
    part?: string;
    road?: { from: string; to: string; toward?: string };
  }>('place');
  const is = latest<{
    skills: Record<string, { value: number; base: number; cap: number; lock: number }>;
    stats?: { strength: number; dexterity: number; intelligence: number };
    statLocks?: number[];
    statCap?: number;
    weapons: { skill: string; value: number }[];
    crafts: { skill: string; value: number }[];
    parry: { shield: number; oneHanded: number; twoHanded: number };
    tames: string[];
    carries?: number;
    growth: { total: number; cap: number; rising: { skill: string; gained: number }[] };
  }>('abilities');
  const has =
    latest<Record<string, Record<string, { amount: number; worth: number; weight: number }> | number>>('holding');
  const lock = (n: number | undefined) => ['up', 'down', 'locked'][n ?? 0] ?? 'up';
  const blocks: Block[] = [];
  if (place)
    blocks.push({
      kind: 'fields',
      rows: [
        ['Where it is', [place.part, place.regions.join(' in ')].filter(Boolean).join(' of ') || 'the wilds'],
        ['Kind of place', `${place.kind}${place.guarded ? ', guarded' : ''}`],
        [
          'Land',
          place.dungeon ? `${place.dungeon}${place.level ? ` level ${place.level}` : ''}` : (place.island ?? '')
        ],
        [
          'Road',
          place.road
            ? `${place.road.from} to ${place.road.to}${place.road.toward ? `, toward ${place.road.toward}` : ''}`
            : ''
        ]
      ]
    });
  if (is) {
    const stats = is.stats;
    blocks.push({
      kind: 'fields',
      rows: [
        [
          'Stats',
          stats
            ? `str ${stats.strength} (${lock(is.statLocks?.[0])}), dex ${stats.dexterity} (${lock(is.statLocks?.[1])}), int ${stats.intelligence} (${lock(is.statLocks?.[2])}) of ${is.statCap ?? '?'}`
            : ''
        ],
        ['Skills', `${num(is.growth.total, 1)} of ${num(is.growth.cap)}`],
        ['Rising this hour', is.growth.rising.map((r) => `${r.skill} +${r.gained}`).join(', ')],
        ['Fights with', is.weapons.map((w) => `${w.skill} ${w.value}`).join(', ')],
        ['Crafts', is.crafts.map((c) => `${c.skill} ${c.value}`).join(', ')],
        [
          'Parry',
          `shield ${num(is.parry.shield * 100, 1)}%, one-handed ${num(is.parry.oneHanded * 100, 1)}%, two-handed ${num(is.parry.twoHanded * 100, 1)}%`
        ],
        ['Can tame', is.tames.slice(0, 8).join(', ')],
        ['Can still carry', is.carries === undefined ? '' : `${num(is.carries)} stones`]
      ]
    });
    blocks.push({
      kind: 'table',
      head: ['Skill', 'Value', 'Base', 'Cap', 'Lock'],
      rows: Object.entries(is.skills)
        .filter(([, s]) => s.base > 0 || s.lock !== 0)
        .sort((a, b) => b[1].value - a[1].value)
        .map(([skill, s]) => [skill, num(s.value, 1), num(s.base, 1), num(s.cap, 1), lock(s.lock)] as Cell[]),
      numeric: [1, 2, 3],
      empty: 'No skills read yet.'
    });
  }
  if (has)
    blocks.push({
      kind: 'table',
      head: ['Where', 'Kind', 'Amount', 'Worth', 'Weight'],
      rows: (['worn', 'pack', 'bank'] as const).flatMap((where) =>
        Object.entries((has[where] as Record<string, { amount: number; worth: number; weight: number }>) ?? {}).map(
          ([kind, t]) => [where, kind, num(t.amount), num(t.worth), num(t.weight, 1)] as Cell[]
        )
      ),
      numeric: [2, 3, 4],
      empty: 'Nothing held yet.'
    });
  return blocks;
}
