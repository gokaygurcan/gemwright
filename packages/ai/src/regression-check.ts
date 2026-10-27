import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Pass or fail for a run's resident log (a local load test's residents.log, or saved Railway
// logs): crashes, loops, residents getting nowhere and runs that end early. Exits 1 when any
// count passes its limit, so a deploy can be held back on it.
//   bun packages/ai/src/regression-check.ts --log <file> [--residents 20] [--minutes 30]
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { log: { type: 'string' }, residents: { type: 'string' }, minutes: { type: 'string' } }
});
if (!values.log) throw new Error('--log is required');
const lines = readFileSync(values.log, 'utf8').split('\n');
const residents = Number(values.residents ?? 20);
const hours = Number(values.minutes ?? 30) / 60;
const count = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).length;
// Expected endings (the run's end, a shutdown, a deploy) are not failures.
const graceful = /run duration reached|shutdown signal|stopped by|Fighter run duration/i;
const checks = [
  { name: 'crashes', n: count(/TypeError|ReferenceError|is not a function|Cannot read prop|ENOENT/), limit: 0 },
  { name: 'loops', n: count(/\[loop\]/), limit: Math.ceil(residents * hours * 0.5) },
  { name: 'no progress', n: count(/no progress in an hour/), limit: Math.ceil(residents * 0.2) },
  {
    name: 'early stops',
    n: lines.filter((line) => /\] stopped: /.test(line) && !graceful.test(line)).length,
    limit: Math.ceil(residents * hours)
  },
  { name: 'deaths', n: count(/\[death\]/), limit: Math.ceil(residents * hours * 0.5) }
];
for (const c of checks) console.log(`${c.n > c.limit ? 'FAIL' : 'ok  '} ${c.name}: ${c.n} (limit ${c.limit})`);
const stops = new Map<string, number>();
for (const line of lines) {
  const m = /\] stopped: (.*)$/.exec(line);
  if (m?.[1] && !graceful.test(m[1]))
    stops.set(m[1].replace(/\d+/g, '#'), (stops.get(m[1].replace(/\d+/g, '#')) ?? 0) + 1);
}
for (const [reason, n] of [...stops].sort((a, b) => b[1] - a[1]).slice(0, 5))
  console.log(`     ${n}× stopped: ${reason}`);
process.exit(checks.some((c) => c.n > c.limit) ? 1 : 0);
