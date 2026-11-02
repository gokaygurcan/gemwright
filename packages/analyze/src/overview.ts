import { FACET_SIZES } from '@gemwright/common/assets/facet';
import { GHOST_BODIES } from '@gemwright/common/game/bodies';

import type { Analysis } from './analysis';
import { type Block, type Cell, type Doc, link, num, type Stat } from './doc';
import type { Snapshot } from './history';
import type { Pulse } from './pulse';
import type { ResidentRow } from './residents';
import type { readLasting } from './trouble';

// The shard at a glance: how the residents are doing now, against the previous pull, over the
// last day (pulse.ts), who needs a look, and where everyone is. The other pages hold the detail.
const HOUR = 3_600_000;
const RESIDENT_FACET = 1;
// Phases in a fixed order, so each keeps its colour (web/charts.tsx).
const PHASES: [string, string][] = [
  ['work', 'Working'],
  ['practice', 'Practising'],
  ['errands', 'Errands'],
  ['visit', 'Visiting'],
  ['leisure', 'Leisure'],
  ['', 'Not recorded']
];

const gold = (n: number) => n.toLocaleString('en-GB');
const signed = (n: number, digits = 0) =>
  `${n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}${Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: digits })}`;
// A change since the previous pull; `better` says which direction is good news.
const delta = (now: number, before: number | undefined, better: 1 | -1, digits = 0): Stat['delta'] => {
  if (before === undefined) return undefined;
  const d = now - before;
  const rounded = Math.round(d * 10 ** digits) / 10 ** digits;
  return {
    text: rounded ? `${signed(rounded, digits)} since the last pull` : 'same as the last pull',
    tone: !rounded ? 'muted' : Math.sign(rounded) === better ? 'good' : 'error'
  };
};

export function overviewDoc(
  a: Analysis,
  rows: ResidentRow[] | undefined,
  lasting: ReturnType<typeof readLasting>,
  history: Snapshot[],
  pulse: Pulse | undefined,
  savedAt: string,
  drawn: boolean
): Doc {
  const subtitle: Cell[] = [
    `${gold(a.characters.length)} characters, ${gold(a.world.items.size)} items in the save`,
    ...(a.world.errors.length ? [`${a.world.errors.length} records not decoded`] : [])
  ];
  if (!rows)
    return { title: 'Overview', subtitle, blocks: [{ kind: 'note', text: 'This pull has no resident database.' }] };

  const bySerial = new Map(a.characters.map((c) => [c.serial, c]));
  const before = [...history]
    .filter((s) => s.at < savedAt)
    .sort((x, y) => x.at.localeCompare(y.at))
    .at(-1);
  const prior = before && Object.values(before.trades);
  const wealth = rows.reduce((n, r) => n + (bySerial.get(r.serial)?.gold.carried ?? 0) + r.bank, 0);
  const skills = rows.reduce((n, r) => n + (bySerial.get(r.serial)?.skillTotal ?? 0), 0) / (rows.length || 1);
  const deaths = rows.reduce((n, r) => n + r.deaths, 0);
  const troubleCells = new Map<string, number>();
  for (const [key] of lasting?.trouble ?? []) {
    const cell = key.split('|')[0] ?? '';
    troubleCells.set(cell, (troubleCells.get(cell) ?? 0) + 1);
  }
  const online = pulse?.online.at(-1)?.[1];
  const stats: Stat[] = [
    {
      label: 'Residents online',
      value: online === undefined ? '—' : `${online} of ${rows.length}`,
      note: 'at the last sample'
    },
    {
      label: 'Resident wealth',
      value: gold(wealth),
      delta: delta(
        wealth,
        prior?.reduce((n, t) => n + t.gold * t.n, 0),
        1
      ),
      note: 'carried and banked gold',
      href: '/economy'
    },
    {
      label: 'Average skill total',
      value: skills.toLocaleString('en-GB', { maximumFractionDigits: 1 }),
      delta: delta(
        skills,
        prior && prior.reduce((n, t) => n + t.skills * t.n, 0) / (prior.reduce((n, t) => n + t.n, 0) || 1),
        1,
        1
      ),
      href: '/residents'
    },
    {
      label: 'Deaths',
      value: gold(deaths),
      delta: delta(deaths, before?.deaths, -1),
      note: 'last 6 hours',
      href: '/trouble'
    },
    {
      label: 'Stalls',
      value: gold(pulse?.stalls.length ?? 0),
      delta: pulse?.stalls.length ? { text: 'the AI service fell behind', tone: 'error' } : undefined,
      note: 'last 24 hours'
    },
    {
      label: 'Places routes avoid',
      value: gold([...troubleCells.values()].filter((n) => n >= 3).length),
      note: `of ${troubleCells.size} with failed walks`,
      href: '/trouble'
    },
    { label: 'Loops', value: gold((lasting?.loops ?? []).length), note: 'last 24 hours', href: '/loops' }
  ];

  const blocks: Block[] = [{ kind: 'stats', items: stats }];
  if (pulse) {
    blocks.push(
      { kind: 'heading', text: 'The last 24 hours' },
      {
        kind: 'line',
        label: 'Residents online',
        points: pulse.online,
        marks: pulse.stalls.map((at) => ({ at, label: 'Stall' }))
      },
      { kind: 'line', label: 'Resident wealth (gold)', points: pulse.wealth },
      {
        kind: 'shares',
        label: 'What residents spent the day doing',
        parts: PHASES.map(([key, label]) => ({ label, value: pulse.phases.get(key) ?? 0 }))
      }
    );
    blocks.push(...attention(a, rows, pulse), ...movers(rows, pulse));
  }
  const dots = rows.flatMap((r) => {
    const m = a.world.mobiles.get(r.serial);
    return m && m.map === RESIDENT_FACET && m.online
      ? [{ x: m.location.x, y: m.location.y, label: r.name, href: `/mobile/${r.serial}` }]
      : [];
  });
  const [width, height] = FACET_SIZES[RESIDENT_FACET] ?? [0, 0];
  blocks.push(
    { kind: 'heading', text: 'Where residents are' },
    { kind: 'minimap', map: RESIDENT_FACET, width, height, drawn, dots }
  );
  return { title: 'Overview', subtitle, blocks };
}

const who = (r: ResidentRow): Cell => link(r.name, `/mobile/${r.serial}`);

function attention(a: Analysis, rows: ResidentRow[], pulse: Pulse): Block[] {
  const list: Cell[][] = [];
  for (const r of rows) {
    const m = a.world.mobiles.get(r.serial);
    const recent = (pulse.residents.get(r.serial) ?? []).filter((s) => s.at >= pulse.end - 6 * HOUR);
    const first = recent[0];
    const last = recent.at(-1);
    const covered = first && last && last.at - first.at >= 5 * HOUR;
    const moved = first
      ? Math.max(...recent.map((s) => Math.max(Math.abs(s.x - first.x), Math.abs(s.y - first.y))))
      : 0;
    const why =
      m && GHOST_BODIES.has(m.body)
        ? 'Dead'
        : covered && last.money <= first.money
          ? `No gold earned in 6 hours, ${moved < 8 ? 'barely moved' : `moved up to ${moved} tiles`}`
          : '';
    if (why) list.push([who(r), r.trade, why, r.note || r.phase || '—', link('replay', `/replay/${r.serial}`)]);
  }
  return [
    { kind: 'heading', text: `Needs a look (${list.length})` },
    {
      kind: 'table',
      head: ['Resident', 'Trade', 'Why', 'Doing now', ''],
      interactive: list.length > 15,
      empty: 'Nobody: everyone alive is earning.',
      rows: list.sort((x, y) => String(x[2]).localeCompare(String(y[2])))
    }
  ];
}

function movers(rows: ResidentRow[], pulse: Pulse): Block[] {
  const changes = rows.flatMap((r) => {
    const samples = pulse.residents.get(r.serial) ?? [];
    const first = samples[0];
    const last = samples.at(-1);
    return first && last && first !== last ? [{ r, change: last.money - first.money, now: last.money }] : [];
  });
  const table = (picked: typeof changes, empty: string): Block => ({
    kind: 'table',
    head: ['Resident', 'Trade', 'Change', 'Gold now'],
    numeric: [2, 3],
    empty,
    rows: picked.map((c) => [
      who(c.r),
      c.r.trade,
      { text: signed(c.change), sort: c.change, tone: c.change > 0 ? 'good' : 'error' },
      num(c.now)
    ])
  });
  const sorted = [...changes].sort((x, y) => y.change - x.change);
  return [
    { kind: 'heading', text: 'Top earners, last 24 hours' },
    table(sorted.filter((c) => c.change > 0).slice(0, 5), 'Nobody gained gold.'),
    { kind: 'heading', text: 'Biggest losses, last 24 hours' },
    table(
      sorted
        .filter((c) => c.change < 0)
        .reverse()
        .slice(0, 5),
      'Nobody lost gold.'
    )
  ];
}
