import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function database(file: string, after: boolean, unknownBank = false) {
  const db = new Database(file);
  db.exec(`CREATE TABLE residents (id TEXT, proposed_name TEXT, template_id TEXT, binding_json TEXT, checkpoint_json TEXT, desired_active INTEGER);
    CREATE TABLE activity_samples (resident_id TEXT, at INTEGER, x INTEGER, y INTEGER, phase TEXT, gold INTEGER, bank INTEGER);
    CREATE TABLE activity (resident_id TEXT, totals_json TEXT);
    CREATE TABLE skill_snapshots (resident_id TEXT, skills_json TEXT);
    CREATE TABLE metadata (key TEXT, value TEXT);`);
  const add = (id: string, active = 1) =>
    db
      .query('INSERT INTO residents VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id === 'same' && after ? 'Renamed resident' : id, 'miner', '{}', '{"memories":[]}', active);
  add('same');
  add('retired', after ? 0 : 1);
  if (!after) add('missing');
  if (after) add('introduced');
  const at = after ? 4 * 3600000 : 1000000;
  db.query('INSERT INTO activity_samples VALUES (?, ?, 100, 100, ?, ?, ?)').run(
    'same',
    at,
    'mining',
    after ? 90 : 100,
    unknownBank && !after ? null : after ? 90 : 50
  );
  db.query('INSERT INTO activity VALUES (?, ?)').run('same', JSON.stringify({ mined: after ? 5 : 2 }));
  db.query('INSERT INTO skill_snapshots VALUES (?, ?)').run(
    'same',
    JSON.stringify({ Swords: { base: after ? 51 : 50, value: after ? 90 : 60 } })
  );
  if (after)
    db.query('INSERT INTO activity_samples VALUES (?, ?, 100, 100, ?, 1000000, 0)').run('introduced', at, 'mining');
  db.close();
}

for (const unknownBank of [false, true])
  test(`snapshot comparison matches UUIDs, separates cohort changes and preserves ${unknownBank ? 'unknown' : 'known'} bank evidence`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemwright-progress-'));
    try {
      const before = join(directory, 'before.sqlite'),
        after = join(directory, 'after.sqlite'),
        out = join(directory, 'report.json');
      database(before, false, unknownBank);
      database(after, true, unknownBank);
      const bytesBefore = readFileSync(before),
        bytesAfter = readFileSync(after);
      const result = Bun.spawnSync(
        [
          process.execPath,
          new URL('../src/progress-report.ts', import.meta.url).pathname,
          '--db',
          after,
          '--before',
          before,
          '--minutes',
          '5',
          '--out',
          out
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(readFileSync(out, 'utf8'));
      expect(report.cohort.matched).toEqual(['same']);
      expect(report.cohort.introduced.map((row: { id: string }) => row.id)).toEqual(['introduced']);
      expect(report.cohort.retired.map((row: { id: string }) => row.id)).toEqual(['retired']);
      expect(report.cohort.missing.map((row: { id: string }) => row.id)).toEqual(['missing']);
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        id: 'same',
        name: 'Renamed resident',
        skills: 1,
        work: 3,
        gold: unknownBank ? 0 : 30,
        comparable: { gold: !unknownBank, skills: true, work: true }
      });
      expect(report.start).toBe(1000000);
      expect(report.end).toBe(4 * 3600000);
      expect(report.minutes).toBeGreaterThan(5);
      expect(readFileSync(before)).toEqual(bytesBefore);
      expect(readFileSync(after)).toEqual(bytesAfter);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
