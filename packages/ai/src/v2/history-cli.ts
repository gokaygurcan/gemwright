import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';

import { ruleMaps } from '@gemwright/common/game/rules';

import { readShardWorld } from '../spawns';
import { know } from './knowledge';
import { Places } from './places';

// Reads residents' v2 histories. Read-only; on the VPS it runs inside the AI container:
//   docker exec <ai container> bun dist/v2/history-cli.js --db /app/data/history.sqlite --minutes 10
// --resident narrows to one resident id, --kind to kinds (comma-separated), --counts tallies kinds,
// --attempts sums up what each kind of attempt has brought, --lifetimes how long each kind of thing
// stays where it was seen, --know <Type> (with --resident and the shard's --world folder) what the
// resident knows about a type: the wiki's facts, where the shard places it, where it believes it is,
// --choices how often what it would have chosen agrees with what it did, and where it differs most.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: 'string' },
    resident: { type: 'string' },
    kind: { type: 'string' },
    minutes: { type: 'string' },
    limit: { type: 'string' },
    counts: { type: 'boolean' },
    attempts: { type: 'boolean' },
    lifetimes: { type: 'boolean' },
    know: { type: 'string' },
    choices: { type: 'boolean' },
    world: { type: 'string' }
  }
});
if (!values.db) throw new Error('--db is required');
const db = new Database(values.db, { readonly: true });
const where: string[] = [];
const args: (string | number)[] = [];
if (values.resident) {
  where.push('resident = ?');
  args.push(values.resident);
}
if (values.kind) {
  const kinds = values.kind.split(',');
  where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
  args.push(...kinds);
}
if (values.minutes) {
  where.push('at >= ?');
  args.push(Date.now() - Number(values.minutes) * 60_000);
}
const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

if (values.choices) {
  const scope = `${filter ? `${filter} AND` : 'WHERE'} kind = 'considered'`;
  const agreement = db
    .query<{ n: number; agrees: number }, typeof args>(
      `SELECT COUNT(*) AS n, SUM(json_extract(data, '$.agrees')) AS agrees FROM events ${scope}`
    )
    .get(...args);
  console.log(`agrees ${agreement?.agrees ?? 0} of ${agreement?.n ?? 0} decisions`);
  const rows = db
    .query<{ choice: string; doing: string; n: number }, typeof args>(
      `SELECT json_extract(data, '$.choice') AS choice, json_extract(data, '$.doing') AS doing, COUNT(*) AS n
      FROM events ${scope} AND json_extract(data, '$.agrees') = 0 GROUP BY choice, doing ORDER BY n DESC LIMIT 15`
    )
    .all(...args);
  for (const r of rows) console.log(`${String(r.n).padStart(5)}  would ${r.choice}  instead of ${r.doing}`);
} else if (values.know) {
  if (!values.resident || !values.world) throw new Error('--know needs --resident and --world');
  const events = (kind: string) =>
    db
      .query<{ data: string }, [string, string]>('SELECT data FROM events WHERE resident = ? AND kind = ? ORDER BY id')
      .all(values.resident as string, kind)
      .map((row) => JSON.parse(row.data) as object);
  const world = readShardWorld(values.world);
  if (!world) throw new Error(`No shard world files in ${values.world}`);
  const wiki = know(values.know, world.spawners);
  const here = db
    .query<{ x: number; y: number; map: number }, [string]>(
      'SELECT x, y, map FROM events WHERE resident = ? AND x IS NOT NULL ORDER BY id DESC LIMIT 1'
    )
    .get(values.resident);
  const facet = here ? ruleMaps[String(here.map) as keyof typeof ruleMaps]?.name : undefined;
  const distance = (p: { x: number; y: number; map: string }) =>
    here && p.map === facet ? Math.max(Math.abs(p.x - here.x), Math.abs(p.y - here.y)) : Number.POSITIVE_INFINITY;
  if (wiki.creature) console.log('creature', JSON.stringify(wiki.creature));
  if (wiki.sells.length) console.log('sells', wiki.sells.map((i) => `${i.type} ${i.price}`).join(', '));
  if (wiki.buys.length) console.log('buys', wiki.buys.map((i) => `${i.type} ${i.price}`).join(', '));
  console.log(`spawned at ${wiki.spawns.length} places; nearest:`);
  for (const p of wiki.spawns.sort((a, b) => distance(a) - distance(b)).slice(0, 5))
    console.log(`  ${p.x},${p.y} ${p.map} (roams ${p.range}${p.map === facet ? `, ${distance(p)} away` : ''})`);
  const believed = new Places(values.resident, () => {}, { lifetimes: events('lifetimes'), left: events('left') })
    .believed(values.know)
    .sort((a, b) => b.confidence - a.confidence);
  console.log(`believed at ${believed.length} places; surest:`);
  for (const p of believed.slice(0, 5))
    console.log(
      `  ${p.x},${p.y}/${p.map} ${(p.confidence * 100).toFixed(0)}% (lifetime ${(p.lifetime / 60).toFixed(1)} min) ${p.name}`
    );
} else if (values.lifetimes) {
  const rows = db
    .query<{ name: string; watched: number; endings: number }, typeof args>(
      `SELECT j.key AS name, SUM(json_extract(j.value, '$.watched')) AS watched,
        SUM(json_extract(j.value, '$.endings')) AS endings
      FROM events, json_each(events.data) AS j ${filter ? `${filter} AND` : 'WHERE'} kind = 'lifetimes'
      GROUP BY name ORDER BY watched / (endings + 1) DESC`
    )
    .all(...args);
  for (const r of rows)
    console.log(
      `${(r.watched / (r.endings + 1) / 60).toFixed(1).padStart(8)} min  watched ${(r.watched / 60).toFixed(0).padStart(5)} min  ended ${String(r.endings).padStart(5)}  ${r.name}`
    );
} else if (values.attempts) {
  const rows = db
    .query<{ key: string; n: number; seconds: number; health: number; skill: number; died: number }, typeof args>(
      `SELECT json_extract(data, '$.key') AS key, COUNT(*) AS n,
        AVG(json_extract(data, '$.observed.seconds')) AS seconds, AVG(json_extract(data, '$.observed.health')) AS health,
        AVG(json_extract(data, '$.observed.skill')) AS skill, SUM(json_extract(data, '$.observed.died')) AS died
      FROM events ${filter ? `${filter} AND` : 'WHERE'} kind = 'outcome' GROUP BY key ORDER BY n DESC`
    )
    .all(...args);
  for (const r of rows)
    console.log(
      `${String(r.n).padStart(5)}  ${r.seconds.toFixed(1).padStart(7)}s  hp ${r.health.toFixed(1).padStart(6)}  skill ${r.skill.toFixed(2).padStart(5)}  died ${r.died}  ${r.key}`
    );
} else if (values.counts) {
  const rows = db
    .query<{ resident: string; kind: string; n: number }, typeof args>(
      `SELECT resident, kind, COUNT(*) AS n FROM events ${filter} GROUP BY resident, kind ORDER BY resident, n DESC`
    )
    .all(...args);
  for (const r of rows) console.log(`${r.resident}  ${r.kind.padEnd(18)} ${r.n}`);
} else {
  const rows = db
    .query<
      {
        resident: string;
        at: number;
        kind: string;
        x: number | null;
        y: number | null;
        map: number | null;
        data: string;
      },
      typeof args
    >(
      `SELECT * FROM (SELECT resident, at, kind, x, y, map, data, id FROM events ${filter} ORDER BY id DESC LIMIT ${Number(values.limit ?? 100)}) ORDER BY id`
    )
    .all(...args);
  for (const r of rows) {
    const place = r.x === null ? '' : ` @${r.x},${r.y}${r.map ? `/${r.map}` : ''}`;
    console.log(`${new Date(r.at).toISOString()} ${r.resident.slice(0, 8)} ${r.kind}${place} ${r.data}`);
  }
}
