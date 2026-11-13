import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { History } from '../src/v2/history';

test('audit export preserves every event in the exact resident and time window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gemwright-audit-'));
  const path = join(directory, 'history.sqlite');
  const start = Date.parse('2026-01-01T12:00:00Z');
  const history = new History(path);
  try {
    for (let i = 0; i < 125; i++)
      history.record({
        resident: 'finn',
        at: start + i * 1000,
        kind: 'considered',
        data: { i },
        where: { x: i, y: 100, z: 0, map: 1 }
      });
    history.record({ resident: 'rowan', at: start, kind: 'considered', data: {} });
    history.flush();
    const run = (args: string[]) =>
      Bun.spawnSync([
        process.execPath,
        fileURLToPath(new URL('../src/v2/history-cli.ts', import.meta.url)),
        '--db',
        path,
        '--json',
        ...args
      ]);
    const result = run([
      '--resident',
      'finn',
      '--since',
      new Date(start + 1000).toISOString(),
      '--until',
      new Date(start + 123000).toISOString()
    ]);
    expect(result.exitCode).toBe(0);
    const rows = result.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(123);
    expect(rows[0]).toMatchObject({ resident: 'finn', at: start + 1000, data: { i: 1 }, x: 1, map: 1 });
    expect(rows.at(-1)).toMatchObject({ at: start + 123000, data: { i: 123 } });
    expect(rows.every((row, i) => i === 0 || row.id > rows[i - 1].id)).toBe(true);
    expect(run(['--since', 'invalid']).exitCode).not.toBe(0);
  } finally {
    history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
