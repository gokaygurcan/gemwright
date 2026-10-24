import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';

// A long-running population, measured from its residents database: who is playing and how
// steadily, what they did and earned, how skills grow, the economy between them, what Jev cost,
// and what players were seen doing. Read-only; on Railway it runs inside the AI container:
//   railway ssh --service <shard>-ai "bun ai/src/report.ts --db /app/data/residents.sqlite"
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { db: { type: 'string' }, days: { type: 'string' } }
});
if (!values.db) throw new Error('--db is required');
const db = new Database(values.db, { readonly: true });
const since = Date.now() - Number(values.days ?? 7) * 24 * 3_600_000;
const has = (table: string) =>
  !!db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get(table)?.n;
const out: string[] = [];
const line = (text = '') => out.push(text);
const hours = (ms: number) => Math.max(1 / 60, ms / 3_600_000);

line(`# Population report (last ${values.days ?? 7} days)`);

// Who: roster by profession, and how many were online across the metric samples.
const roster = db
  .query<{ template_id: string; desired_active: number }, []>('SELECT template_id, desired_active FROM residents')
  .all();
const byProfession = new Map<string, number>();
for (const r of roster.filter((r) => r.desired_active)) {
  const profession = r.template_id.replace(/^[a-z]+(?:-brae)?-/, '');
  byProfession.set(profession, (byProfession.get(profession) ?? 0) + 1);
}
line(
  `\n## Population\n\nActive residents: ${roster.filter((r) => r.desired_active).length} (${roster.length} in the roster)`
);
line(
  [...byProfession]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} ${n}`)
    .join(', ')
);
if (has('population_metrics')) {
  const m = db
    .query<{ n: number; online: number; low: number; rss: number; lag: number; stalls: number }, [number]>(
      `SELECT COUNT(*) n, AVG(online) online, MIN(online) low, MAX(rss_mb) rss, MAX(lag_max_ms) lag, SUM(stalls) stalls
       FROM population_metrics WHERE at > ?`
    )
    .get(since);
  if (m?.n)
    line(
      `\nOnline: ${Math.round(m.online)} on average, ${m.low} at the lowest (${m.n} samples). Memory peak ${m.rss} MB; worst event-loop lag ${m.lag} ms; ${m.stalls} stalls over 1.5 s.`
    );
}

// What: activity totals, as rates over the sampled time.
if (has('activity') && has('activity_samples')) {
  const span = db
    .query<{ first: number; last: number }, []>('SELECT MIN(at) first, MAX(at) last FROM activity_samples')
    .get();
  const totals: Record<string, number> = {};
  for (const r of db.query<{ totals_json: string }, []>('SELECT totals_json FROM activity').all())
    for (const [k, v] of Object.entries(JSON.parse(r.totals_json) as Record<string, number>))
      totals[k] = (totals[k] ?? 0) + v;
  const recorded = span?.first ? hours((span.last ?? 0) - span.first) : 1;
  line(`\n## Activity (since ${span?.first ? new Date(span.first).toISOString() : 'never'})\n`);
  line('| | Total | Per hour |\n|---|---|---|');
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1]))
    line(`| ${k} | ${v.toLocaleString('en')} | ${Math.round(v / recorded).toLocaleString('en')} |`);
  const wealth = db
    .query<{ gold: number; bank: number }, []>(
      'SELECT SUM(COALESCE(gold, 0)) gold, SUM(COALESCE(bank, 0)) bank FROM activity_samples WHERE at = (SELECT MAX(at) FROM activity_samples)'
    )
    .get();
  line(`\nGold now: ${wealth?.gold ?? 0} carried, ${wealth?.bank ?? 0} last reported banked.`);
}

// Skills: the spread of skill totals now.
const skills = (
  has('skill_snapshots') ? db.query<{ skills_json: string }, []>('SELECT skills_json FROM skill_snapshots').all() : []
)
  .map((r) =>
    Object.values(JSON.parse(r.skills_json) as Record<string, { base?: number }>).reduce((n, s) => n + (s.base ?? 0), 0)
  )
  .sort((a, b) => a - b);
if (skills.length)
  line(
    `\n## Skills\n\nSkill points per resident: lowest ${skills[0]?.toFixed(1)}, median ${skills[Math.floor(skills.length / 2)]?.toFixed(1)}, highest ${skills.at(-1)?.toFixed(1)}.`
  );

// Economy: trades between residents (and players), by good, with why failed ones failed.
if (has('trade_log')) {
  line('\n## Trades\n\n| Good | Side | Done | Failed | Amount | Gold |\n|---|---|---|---|---|---|');
  for (const r of db
    .query<{ good: string; role: string; done: number; failed: number; amount: number; gold: number }, [number]>(
      `SELECT good, role, SUM(completed) done, SUM(1 - completed) failed, SUM(amount * completed) amount, SUM(price * completed) gold
       FROM trade_log WHERE at > ? GROUP BY good, role ORDER BY good, role`
    )
    .all(since))
    line(`| ${r.good} | ${r.role} | ${r.done} | ${r.failed} | ${r.amount ?? 0} | ${r.gold ?? 0} |`);
  const reasons = db
    .query<{ reason: string; n: number }, [number]>(
      'SELECT reason, COUNT(*) n FROM trade_log WHERE at > ? AND completed = 0 AND reason IS NOT NULL GROUP BY reason ORDER BY n DESC'
    )
    .all(since);
  if (reasons.length) line(`\nWhy deals failed: ${reasons.map((r) => `${r.reason} (${r.n})`).join(', ')}`);
}

// Animals: horses and pack animals by state.
const states = { mount: new Map<string, number>(), pack: new Map<string, number>() };
const banked: number[] = [];
for (const r of db.query<{ c: string }, []>('SELECT checkpoint_json c FROM residents WHERE desired_active = 1').all()) {
  const c = JSON.parse(r.c) as { mount?: { state: string }; packAnimal?: { state: string }; funds?: { bank: number } };
  banked.push(c.funds?.bank ?? 0);
  for (const [key, value] of [
    ['mount', c.mount?.state],
    ['pack', c.packAnimal?.state]
  ] as const)
    states[key].set(value ?? 'none', (states[key].get(value ?? 'none') ?? 0) + 1);
}
const show = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n}`).join(', ');
line(`\n## Animals\n\nHorses: ${show(states.mount)}\nPack animals: ${show(states.pack)}`);

// Wealth (activity_samples, every five minutes): carried gold plus the last reported bank
// balance, per profession: the median now and how fast it grows, first to last sample of the window.
if (has('activity_samples')) {
  const rows = db
    .query<{ id: string; t: string; first: number; last: number; a: number; b: number }, [number]>(
      `WITH span AS (SELECT resident_id, MIN(at) f, MAX(at) l FROM activity_samples WHERE at > ? GROUP BY resident_id)
       SELECT span.resident_id id, r.template_id t, f first, l last,
        (SELECT COALESCE(gold, 0) + COALESCE(bank, 0) FROM activity_samples x WHERE x.resident_id = span.resident_id AND x.at = f) a,
        (SELECT COALESCE(gold, 0) + COALESCE(bank, 0) FROM activity_samples x WHERE x.resident_id = span.resident_id AND x.at = l) b
       FROM span JOIN residents r ON r.id = span.resident_id`
    )
    .all(since);
  const groups = new Map<string, { now: number[]; rate: number[] }>();
  for (const r of rows) {
    const group = groups.get(r.t.replace(/^[a-z]+(?:-brae)?-/, '')) ?? { now: [], rate: [] };
    groups.set(r.t.replace(/^[a-z]+(?:-brae)?-/, ''), group);
    group.now.push(r.b);
    if (r.last - r.first >= 2 * 3_600_000) group.rate.push((r.b - r.a) / hours(r.last - r.first));
  }
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
  line('\n## Wealth\n\n| Profession | Median gold | Richest | Median gold an hour |\n|---|---|---|---|');
  for (const [name, g] of [...groups].sort((a, b) => median(b[1].now) - median(a[1].now)))
    line(`| ${name} | ${median(g.now)} | ${Math.max(...g.now)} | ${g.rate.length ? median(g.rate).toFixed(0) : '-'} |`);
}

// Housing (house-lots.ts): houses by kind, claims, refused lots, and who is saving (5,000 banked)
// or could buy (the dearest house, the tool and the 3,000 reserve: 40,377).
if (has('houses')) {
  const kinds = db
    .query<{ house: string; n: number }, []>(
      "SELECT house, COUNT(*) n FROM houses WHERE status = 'placed' GROUP BY house ORDER BY n DESC"
    )
    .all();
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  line(
    `\n## Housing\n\nHouses: ${kinds.reduce((n, k) => n + k.n, 0)}${kinds.length ? ` (${kinds.map((k) => `${k.house} ${k.n}`).join(', ')})` : ''}`
  );
  line(
    `Lots claimed: ${count("SELECT COUNT(*) n FROM houses WHERE status = 'claimed'")}, refused by the server: ${count('SELECT COUNT(*) n FROM bad_lots')}`
  );
  line(
    `Saving: ${banked.filter((g) => g >= 5000 && g < 40377).length}, able to buy: ${banked.filter((g) => g >= 40377).length}`
  );
}

// Guilds and wars (guild-store.ts).
if (has('guilds')) {
  const rows = db
    .query<{ name: string; abbr: string; side: string; alliance: string | null; n: number }, []>(
      'SELECT g.name, g.abbr, g.side, g.alliance, COUNT(m.member) n FROM guilds g LEFT JOIN guild_members m ON m.guild = g.name GROUP BY g.name ORDER BY g.founded_at'
    )
    .all();
  line(`\n## Guilds\n\n${rows.length ? '| Guild | Side | Alliance | Members |\n|---|---|---|---|' : 'No guilds.'}`);
  for (const g of rows) line(`| ${g.name} [${g.abbr}] | ${g.side} | ${g.alliance ?? '-'} | ${g.n} |`);
  const wars = db
    .query<{ id: number; declarer: string; opponent: string; status: string; started_at: number | null }, []>(
      'SELECT id, declarer, opponent, status, started_at FROM guild_wars ORDER BY declared_at DESC LIMIT 10'
    )
    .all();
  for (const w of wars) {
    const kills = db
      .query<{ guild: string; n: number }, [number]>(
        'SELECT killer_guild guild, COUNT(*) n FROM war_kills WHERE war = ? GROUP BY killer_guild'
      )
      .all(w.id);
    line(
      `War ${w.declarer} vs ${w.opponent}: ${w.status}${w.started_at ? ` since ${new Date(w.started_at).toISOString()}` : ''}; kills ${kills.map((k) => `${k.guild} ${k.n}`).join(', ') || 'none'}`
    );
  }
}

// Cost: Jev decisions charged to the shared daily budget.
if (has('decision_spend')) {
  const spend = db
    .query<{ day: string; input_tokens: number }, []>(
      'SELECT day, input_tokens FROM decision_spend ORDER BY day DESC LIMIT 30'
    )
    .all();
  const usd = spend.reduce((n, r) => n + (r.input_tokens * 0.042) / 1_000_000, 0);
  line(`\n## Model cost\n\nJev: $${usd.toFixed(4)} over ${spend.length} day(s) recorded.`);
}

// Dungeons and players.
if (has('dungeon_runs')) {
  const runs = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM dungeon_runs').get()?.n ?? 0;
  line(`\n## Dungeons\n\nRuns recorded: ${runs}`);
}
if (has('player_signals')) {
  const signals = db
    .query<{ kind: string; n: number; who: number }, [number]>(
      'SELECT kind, COUNT(*) n, COUNT(DISTINCT serial) who FROM player_signals WHERE at > ? GROUP BY kind'
    )
    .all(since);
  line(
    `\n## Players\n\n${signals.map((s) => `${s.kind}: ${s.n} from ${s.who} player(s)`).join('\n') || 'No player signals.'}`
  );
}
console.log(out.join('\n'));
