import { expect, test } from 'bun:test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneRecordings } from '../src/recording';

// A resident recorded for days keeps only its last day of hourly files, so the disk does not fill.
test('only the last day of hourly recordings is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recordings-'));
  const hours = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 10, 8, i)).toISOString().slice(0, 13));
  for (const hour of hours) await writeFile(join(dir, `${hour}.jsonl`), '{}\n');
  await pruneRecordings(dir);
  expect((await readdir(dir)).sort()).toEqual(hours.slice(-24).map((hour) => `${hour}.jsonl`));
});
