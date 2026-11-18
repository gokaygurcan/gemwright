import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';

import { Chain, Land, liveOf, type Row, type Saved, tuned } from './engine';
import type { LabResponse, Scenario, Weighing } from './types';

// The lab's worker (lab.ts runs it): one pull's land loaded once, answering one request at a time,
// a JSON line in on stdin, a JSON line out marked with REPLY (the AI's own log lines go to stdout too).
//   weigh: one decision made again as it was and with a scenario changed.
//   span: a resident's decisions over a stretch made again with a scenario, from the kept mind
//   nearest before its start; one REPLY line each, then one saying it is done.
//   bun src/lab/worker.ts --data <land folder> --minds <folder of kept minds, one per resident>
export const REPLY = '\u0001';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1] ?? '']] : []))
);
const minds = args.minds ?? '';
const land = await Land.open(args.data ?? '');
const reply = (line: object) => process.stdout.write(`${REPLY}${JSON.stringify(line)}\n`);

// The kept minds of a resident, by the decision each was kept at, oldest first.
const kept = new Map<string, number[]>();
const keptOf = (resident: string) => {
  const folder = join(minds, resident);
  if (!kept.has(resident))
    kept.set(
      resident,
      existsSync(folder)
        ? readdirSync(folder)
            .map((file) => Number(file.split('.')[0]))
            .filter(Number.isFinite)
            .sort((a, b) => a - b)
        : []
    );
  return kept.get(resident) ?? [];
};
const load = (resident: string, decision: number) =>
  deserialize(Bun.gunzipSync(readFileSync(join(minds, resident, `${decision}.bin`)))) as Saved;

// The mind as it stood at the start of a decision, kept for the next what-if on the same one.
let at: { id: number; saved: Saved } | undefined;

function savedAt(row: Row & { resident: string }): Saved {
  if (at?.id === row.id) return at.saved;
  const from = keptOf(row.resident).findLast((id) => id <= row.id);
  if (from === undefined)
    throw new Error('No mind is kept before this decision: run its resident on the Choices page first.');
  // Each decision between weighed on the way, as the chain that kept the mind weighed them.
  const chain = Chain.from(land, load(row.resident, from));
  for (const between of land.between(row.resident, from, row.id)) {
    const trace = chain.reach(between);
    if (typeof trace !== 'string') chain.weigh(between, trace);
  }
  const trace = chain.reach(row);
  if (typeof trace === 'string') throw new Error(`This decision cannot be made again: ${trace}.`);
  at = { id: row.id, saved: chain.save(row.id) };
  return at.saved;
}

function weighOnce(row: Row & { resident: string }, scenario: Scenario, label: string): Weighing {
  const chain = Chain.from(land, savedAt(row));
  const trace = chain.reach(row);
  if (typeof trace === 'string') throw new Error(trace);
  return tuned(scenario.tuning, () => chain.weigh(row, trace, scenario, label));
}

function weigh(request: { id: number; scenario?: Scenario; name?: string }): LabResponse {
  const row = land.decision(request.id);
  if (!row) throw new Error(`No decision #${request.id}.`);
  const label = request.name ?? row.resident.slice(0, 8);
  const original = weighOnce(row, {}, label);
  const changed =
    request.scenario && Object.keys(request.scenario).length ? weighOnce(row, request.scenario, label) : undefined;
  return { live: liveOf(row), original, ...(changed ? { changed } : {}) };
}

function span(request: { resident: string; first: number; last: number; scenario: Scenario }) {
  const rows = [...land.between(request.resident, request.first, request.last), land.decision(request.last)].filter(
    (row): row is NonNullable<typeof row> => !!row
  );
  const first = rows[0];
  if (!first) return reply({ done: true, total: 0 });
  const from = keptOf(request.resident).findLast((id) => id <= first.id);
  if (from === undefined)
    throw new Error('No mind is kept before this stretch: run its resident on the Choices page first.');
  reply({ total: rows.length });
  tuned(request.scenario.tuning, () => {
    const chain = Chain.from(land, load(request.resident, from));
    for (const row of land.between(request.resident, from, first.id)) {
      const trace = chain.reach(row);
      if (typeof trace !== 'string') chain.weigh(row, trace, request.scenario);
    }
    for (const row of rows) {
      const trace = chain.reach(row);
      if (typeof trace === 'string') {
        reply({ id: row.id, error: trace });
        continue;
      }
      const weighed = chain.weigh(row, trace, request.scenario);
      reply({ id: row.id, at: row.at, kind: row.kind, chose: weighed.chose });
    }
  });
  reply({ done: true });
}

for await (const line of console) {
  if (!line.trim()) continue;
  const request = JSON.parse(line) as { op: string; [key: string]: unknown };
  try {
    if (request.op === 'weigh') reply({ ok: weigh(request as unknown as Parameters<typeof weigh>[0]) });
    else if (request.op === 'span') span(request as unknown as Parameters<typeof span>[0]);
    else if (request.op === 'forget') {
      kept.clear();
      at = undefined;
      reply({ ok: true });
    } else reply({ error: `Unknown request ${request.op}.` });
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error), done: true });
  }
}
