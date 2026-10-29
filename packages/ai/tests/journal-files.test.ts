import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { replayFiles } from '../src/event-replay';
import { JournalFiles } from '../src/journal-files';
import { makeEvent } from '../src/telemetry';

const options = { traceBudgetBytes: 3000, segmentBytes: 1000, reserveBytes: 0 };
test('diagnostic rotation is bounded while life outcomes, warnings, and legacy history survive restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-journal-budget-'));
  try {
    const legacy = makeEvent('resident', 'death', 'observed', { killer: null });
    await writeFile(join(directory, 'legacy.jsonl.gz'), gzipSync(`${JSON.stringify(legacy)}\n`));
    let files = new JournalFiles(directory, options);
    await files.initialize();
    const history = makeEvent('resident', 'moveItem', 'completed', { amount: 50 });
    const warning = makeEvent('runtime', 'operational_log', 'failed', { reason: 'refused' }, { level: 'warn' });
    await files.write([history, warning]);
    for (let i = 0; i < 8; i++)
      await files.write([
        makeEvent('perception', 'perception_delta', 'observed', { payload: randomBytes(1500).toString('hex') })
      ]);
    const before = files.statistics();
    expect(before.evictedFiles).toBeGreaterThan(0);
    expect(before.traceBytes).toBeLessThanOrEqual(options.traceBudgetBytes);
    files = new JournalFiles(directory, options);
    await files.initialize();
    await files.write([
      makeEvent('perception', 'perception_delta', 'observed', { payload: randomBytes(1500).toString('hex') })
    ]);
    expect(files.statistics().traceBytes).toBeLessThanOrEqual(options.traceBudgetBytes);
    const names = await readdir(directory);
    const rows = [];
    for (const name of names.filter((name) => !name.includes('.trace.')))
      rows.push(
        ...gunzipSync(await readFile(join(directory, name)))
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      );
    expect(rows.some((event) => event.id === legacy.id)).toBe(true);
    expect(rows.some((event) => event.id === history.id)).toBe(true);
    expect(rows.some((event) => event.id === warning.id)).toBe(true);
    expect(rows.some((event) => event.type === 'journal_retention' && event.details.replayComplete === false)).toBe(
      true
    );
    expect((await replayFiles(names.map((name) => join(directory, name)))).replayComplete).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('disk reserve rejects an unacknowledged batch without deleting life history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-journal-reserve-'));
  try {
    const event = makeEvent('resident', 'banking', 'completed', { amount: 1 });
    const original = gzipSync(`${JSON.stringify(event)}\n`);
    await writeFile(join(directory, 'legacy.jsonl.gz'), original);
    const files = new JournalFiles(directory, { ...options, reserveBytes: Number.MAX_SAFE_INTEGER });
    await files.initialize();
    await expect(files.write([event])).rejects.toThrow('disk reserve');
    expect(await readFile(join(directory, 'legacy.jsonl.gz'))).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
