import { parseArgs } from 'node:util';

import { replayFiles } from './event-replay';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    resident: { type: 'string' },
    session: { type: 'string' },
    trace: { type: 'string' },
    after: { type: 'string' },
    before: { type: 'string' },
    limit: { type: 'string', default: '1000' }
  }
});
if (!positionals.length)
  throw new Error(
    'Usage: bun packages/ai/src/replay.ts <journal.jsonl.gz>... [--resident ID] [--session ID] [--trace ID] [--after ISO] [--before ISO] [--limit 1000]'
  );
for (const date of [values.after, values.before])
  if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid replay date');
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Replay limit must be between 1 and 10000');
console.log(
  JSON.stringify(
    await replayFiles(positionals, {
      residentId: values.resident,
      sessionId: values.session,
      traceId: values.trace,
      after: values.after ? new Date(values.after).toISOString() : undefined,
      before: values.before ? new Date(values.before).toISOString() : undefined,
      limit
    }),
    null,
    2
  )
);
