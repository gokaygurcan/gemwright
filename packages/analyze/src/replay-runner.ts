import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serialize } from 'node:v8';

import { Chain, Land, liveOf } from './lab/engine';

// Every decision of one resident over a span, made again in order by one mind (lab/engine.ts): one
// JSON line per waking and decision to --out. With --minds, the mind is kept there as it stood at the
// first decision of each waking and every --every decisions after, for the lab to take up.
//   bun src/replay-runner.ts --data <land folder> --resident <id> --since <ms> --until <ms> --out <file> [--minds <dir>]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    data: { type: 'string' },
    resident: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    out: { type: 'string' },
    minds: { type: 'string' },
    every: { type: 'string' }
  }
});
const resident = values.resident ?? '';
const out = values.out ?? '';
const every = Number(values.every) || 50;
writeFileSync(out, '');
const emit = (line: object) => appendFileSync(out, `${JSON.stringify(line)}\n`);
// Minds an earlier run kept are of another mind: only this run's are kept.
if (values.minds) {
  rmSync(values.minds, { recursive: true, force: true });
  mkdirSync(values.minds, { recursive: true });
}

const realNow = Date.now;
const land = await Land.open(values.data ?? '');
// Where the resident stood as of an event: every event carries its place.
const where = land.db.query<{ x: number; y: number }, [string, number]>(
  'SELECT x, y FROM events WHERE +resident = ? AND id <= ? AND x IS NOT NULL ORDER BY id DESC LIMIT 1'
);
const decisions = land.decisions(resident, Number(values.since), Number(values.until));
const chain = new Chain(land, resident, (report) => emit({ type: 'wake', ...report }));
emit({
  type: 'start',
  resident,
  since: Number(values.since),
  until: Number(values.until),
  decisions: decisions.length,
  wakes: land.history.wakes(resident).length
});
try {
  let since = 0;
  let wake: number | undefined;
  for (const row of decisions) {
    const trace = chain.reach(row);
    if (typeof trace === 'string') {
      emit({
        type: 'decision',
        id: row.id,
        kind: row.kind,
        at: row.at,
        ...(trace === 'not traced' ? { untraced: true } : { error: trace })
      });
      continue;
    }
    const overlap = chain.met > trace.from;
    if (values.minds && (chain.current?.id !== wake || ++since >= every)) {
      wake = chain.current?.id;
      since = 0;
      writeFileSync(join(values.minds, `${row.id}.bin`), Bun.gzipSync(serialize(chain.save(row.id))));
    }
    const weighed = chain.weigh(row, trace);
    const live = liveOf(row);
    emit({
      type: 'decision',
      id: row.id,
      kind: row.kind,
      at: row.at,
      wake: chain.current?.id,
      overlap,
      same: live.digest !== undefined && live.digest === weighed.digest,
      digest: { live: live.digest, replay: weighed.digest },
      stood: { live: where.get(resident, trace.from) ?? null, replay: weighed.position ?? null },
      chose: { live: live.chose, replay: weighed.chose },
      options: weighed.options.slice(0, 8),
      count: weighed.options.length,
      unanswered: Object.keys(weighed.answers).filter((q) => !trace.tape.some(([asked]) => asked === q)),
      ms: weighed.ms
    });
  }
  emit({ type: 'end' });
} catch (error) {
  emit({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 1;
} finally {
  Date.now = realNow;
  land.close();
}
