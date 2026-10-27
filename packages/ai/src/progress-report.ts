import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Step 0 of the life-goal plan (ROADMAP.md): is each resident growing stronger and richer, or is
// it looping, idle, wandering or stranded? Read-only, over a resident database (a pull, or a copy
// of the live one). Over the last `--minutes` it looks at each resident's gold and bank samples,
// where it went, and what it remembers doing; with `--before` (an older copy of the database) it
// also compares skills and activity counts.
//   bun packages/ai/src/progress-report.ts --db <residents.sqlite> [--before <older.sqlite>] [--minutes 60] [--out report.json]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: 'string' },
    before: { type: 'string' },
    minutes: { type: 'string' },
    out: { type: 'string' }
  }
});
if (!values.db) throw new Error('--db is required');
const minutes = Number(values.minutes ?? 60);

type Label = 'productive' | 'looping' | 'idle' | 'wandering' | 'stranded' | 'died';
interface Row {
  name: string;
  trade: string;
  serial: number;
  label: Label;
  reason: string;
  gold: number;
  places: number;
  skills: number;
  work: number;
  deaths: string[];
  // The longest stretch, in minutes, standing within a few tiles with no gold change, outside a
  // timed break (leisure, practice).
  idleMinutes: number;
  phases: Record<string, number>;
}

// Counts that only grow with real work (activity.ts tallies).
const WORK = ['mined', 'chopped', 'fished', 'crafted', 'kills', 'goldFromShops', 'tamed', 'stolen', 'escorts'];
// Remembered lines that are progress in themselves.
const PROGRESS =
  /\b(killed|defeated|looted|mined|chopped|caught|sold|crafted|tamed|bought|earned|paid|smelted|gained|delivered)\b/i;
const STRANDED = /No public moongate can be reached|stranded/i;
// One memory in a comparable form: numbers and coordinates do not make a step different.
const shape = (text: string) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 90);

const open = (file: string) => new Database(file, { readonly: true });
const now = open(values.db);
const end = now.query<{ at: number }, []>('SELECT MAX(at) AS at FROM activity_samples').get()?.at ?? Date.now();
const start = end - minutes * 60_000;

const before = values.before ? open(values.before) : undefined;
// Deaths in the window, by character serial, with where and what was near (death-log, resurrection.ts).
const deathLog =
  (
    JSON.parse(
      now.query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?').get('lasting')?.value ?? '{}'
    ) as Record<string, [string, number][]>
  )['death-log'] ?? [];
const deaths = new Map<number, string[]>();
for (const [key] of deathLog) {
  const [serial = '0', place = '', cause = 'unknown', at = '0'] = key.split('|');
  if (Number(at) < start) continue;
  deaths.set(Number(serial), [...(deaths.get(Number(serial)) ?? []), `${place} (${cause})`]);
}
// The last gold and bank sample before the window: the start for residents with no sample in it.
const worthAt = (id: string) =>
  now
    .query<{ w: number }, [string, number]>(
      'SELECT COALESCE(gold, 0) + COALESCE(bank, 0) AS w FROM activity_samples WHERE resident_id = ? AND at <= ? ORDER BY at DESC LIMIT 1'
    )
    .get(id, start)?.w;
const skillTotal = (db: Database | undefined, id: string) => {
  const row = db
    ?.query<{ s: string }, [string]>('SELECT skills_json AS s FROM skill_snapshots WHERE resident_id = ?')
    .get(id);
  if (!row) return undefined;
  const skills = JSON.parse(row.s) as Record<string, number | { value: number }>;
  return Object.values(skills).reduce<number>((n, v) => n + (typeof v === 'number' ? v : v.value), 0);
};
const workDone = (db: Database | undefined, id: string) => {
  const row = db?.query<{ t: string }, [string]>('SELECT totals_json AS t FROM activity WHERE resident_id = ?').get(id);
  if (!row) return undefined;
  const totals = JSON.parse(row.t) as Record<string, number>;
  return WORK.reduce((n, k) => n + (totals[k] ?? 0), 0);
};

// The most repeated run of 2 to 6 steps and how often it repeats back to back or apart.
function repeated(steps: string[]) {
  let best = { run: [] as string[], times: 0 };
  for (let size = 2; size <= 6; size++)
    for (let i = 0; i + size <= steps.length; i++) {
      const run = steps.slice(i, i + size);
      if (new Set(run).size < 2) continue;
      let times = 0;
      for (let j = 0; j + size <= steps.length; )
        if (steps.slice(j, j + size).every((s, k) => s === run[k])) {
          times++;
          j += size;
        } else j++;
      if (times > best.times || (times === best.times && size > best.run.length)) best = { run, times };
    }
  return best;
}

const residents = now
  .query<{ id: string; name: string; template: string; binding: string | null; checkpoint: string }, []>(
    'SELECT id, proposed_name AS name, template_id AS template, binding_json AS binding, checkpoint_json AS checkpoint FROM residents WHERE desired_active = 1'
  )
  .all();
const rows: Row[] = residents.map((r) => {
  const samples = now
    .query<{ at: number; x: number; y: number; phase: string; gold: number; bank: number }, [string, number]>(
      'SELECT at, x, y, phase, COALESCE(gold, 0) AS gold, COALESCE(bank, 0) AS bank FROM activity_samples WHERE resident_id = ? AND at >= ? ORDER BY at'
    )
    .all(r.id, start);
  const first = samples[0];
  const last = samples.at(-1);
  const opening = worthAt(r.id) ?? (first ? first.gold + first.bank : 0);
  const gold = last ? last.gold + last.bank - opening : 0;
  // Idle stretches: samples about a minute apart, still within 3 tiles, worth unchanged, not on a break.
  let idleMinutes = 0;
  let stillSince: (typeof samples)[number] | undefined;
  for (const s of samples) {
    const still =
      stillSince &&
      Math.max(Math.abs(s.x - stillSince.x), Math.abs(s.y - stillSince.y)) <= 3 &&
      s.gold + s.bank === stillSince.gold + stillSince.bank &&
      !['leisure', 'practice'].includes(s.phase);
    if (!still) stillSince = s;
    else if (stillSince) idleMinutes = Math.max(idleMinutes, (s.at - stillSince.at) / 60_000);
  }
  const places = new Set(samples.map((s) => `${s.x >> 4},${s.y >> 4}`)).size;
  const phases: Record<string, number> = {};
  for (const s of samples) phases[s.phase ?? '?'] = (phases[s.phase ?? '?'] ?? 0) + 1;
  const checkpoint = JSON.parse(r.checkpoint) as { memories?: { at: string; text: string }[] };
  const memories = (checkpoint.memories ?? []).filter((m) => Date.parse(m.at) >= start && !/ said "/.test(m.text));
  const steps = memories.map((m) => shape(m.text));
  const skills = (skillTotal(now, r.id) ?? 0) - (skillTotal(before, r.id) ?? skillTotal(now, r.id) ?? 0);
  const work = (workDone(now, r.id) ?? 0) - (workDone(before, r.id) ?? workDone(now, r.id) ?? 0);
  const progressed = memories.find((m) => PROGRESS.test(m.text));
  const loop = repeated(steps);
  const serial = Number((JSON.parse(r.binding ?? '{}') as { characterSerial?: string }).characterSerial ?? 0);
  const died = deaths.get(serial) ?? [];
  const base = {
    name: r.name,
    trade: r.template,
    serial,
    gold,
    places,
    skills: Math.round(skills * 10) / 10,
    work,
    deaths: died,
    idleMinutes: Math.round(idleMinutes),
    phases
  };
  const recent = steps.slice(-3).join(' / ') || 'nothing remembered in the window';
  if (died.length) return { ...base, label: 'died', reason: died.join('; ') };
  if (memories.some((m) => STRANDED.test(m.text)) && gold <= 0 && work <= 0)
    return { ...base, label: 'stranded', reason: memories.findLast((m) => STRANDED.test(m.text))?.text ?? '' };
  // Real gains make a resident productive. Samples come every five minutes, so standing still is
  // only certain over two in a row (10 minutes); finer than that is the runtime guard's job.
  if (gold > 0 || skills > 0 || work > 0 || (!before && progressed))
    return {
      ...base,
      label: 'productive',
      reason: [
        gold > 0 ? `+${gold} gold` : '',
        skills > 0 ? `+${skills.toFixed(1)} skill` : '',
        work > 0 ? `+${work} work` : '',
        progressed && !(gold > 0 || skills > 0 || work > 0) ? progressed.text.slice(0, 80) : ''
      ]
        .filter(Boolean)
        .join(', ')
    };
  if (idleMinutes >= 10)
    return { ...base, label: 'idle', reason: `${Math.round(idleMinutes)} min standing still: ${recent}` };
  if (loop.times >= 3) return { ...base, label: 'looping', reason: `${loop.times}× ${loop.run.join(' → ')}` };
  if (places <= 2) return { ...base, label: 'idle', reason: recent };
  return { ...base, label: 'wandering', reason: `${places} places, no progress: ${recent}` };
});

const order: Label[] = ['died', 'stranded', 'looping', 'idle', 'wandering', 'productive'];
const count = (label: Label, list = rows) => list.filter((r) => r.label === label).length;
console.log(
  `Last ${minutes} minutes to ${new Date(end).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${rows.length} residents${before ? ', skills and work compared with --before' : ''}`
);
console.log(order.map((l) => `${l} ${count(l)}`).join(' · '));
// The life goal in three numbers: better skills, more gold, fewer deaths.
const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
console.log(
  `Population: skills ${before ? `${sum((r) => r.skills) >= 0 ? '+' : ''}${sum((r) => r.skills).toFixed(1)}` : 'n/a (needs --before)'} · gold ${sum((r) => r.gold) >= 0 ? '+' : ''}${sum((r) => r.gold).toLocaleString('en-GB')} · deaths ${sum((r) => r.deaths.length)} · residents gaining skill ${rows.filter((r) => r.skills > 0).length}, gaining gold ${rows.filter((r) => r.gold > 0).length}`
);
const trades = [...new Set(rows.map((r) => r.trade))].sort();
console.log('\nBy trade (productive of all):');
for (const t of trades) {
  const list = rows.filter((r) => r.trade === t);
  console.log(
    `  ${t.padEnd(26)} ${String(count('productive', list)).padStart(3)} / ${String(list.length).padEnd(3)} ${order
      .slice(0, 5)
      .filter((l) => count(l, list))
      .map((l) => `${l} ${count(l, list)}`)
      .join(', ')}`
  );
}
for (const label of order.slice(0, 5)) {
  const list = rows.filter((r) => r.label === label);
  if (!list.length) continue;
  console.log(`\n${label} (${list.length}):`);
  for (const r of list) console.log(`  ${r.name.padEnd(18)} ${r.trade.padEnd(24)} ${r.reason.slice(0, 160)}`);
}
if (values.out) writeFileSync(values.out, `${JSON.stringify({ end, minutes, rows }, null, 1)}\n`);
