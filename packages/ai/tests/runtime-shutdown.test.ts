import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const hang of [false, true])
  test(`runtime shutdown ${hang ? 'exits for supervisor recovery when a behavior hangs' : 'finishes cleanly when behaviors settle'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemwright-shutdown-'));
    try {
      const script = `
        import { withRuntime } from ${JSON.stringify(new URL('../src/run-session.ts', import.meta.url).pathname)};
        import population from ${JSON.stringify(new URL('../templates/population.example.json', import.meta.url).pathname)};
        for (const template of population.templates) {
          template.version = 1;
          if (template.id === 'britain-miner') template.creation.city = 'Britain';
        }
        const timeout = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 30000 ? 30 : ms, ...args);
        await withRuntime({
          dbPath: ${JSON.stringify(join(directory, 'residents.sqlite'))},
          population,
          connection: { shardId: population.shardId }
        }, async (shared) => {
          const stopped = new Promise(resolve => shared.signal.addEventListener('abort', resolve, { once: true }));
          process.kill(process.pid, 'SIGTERM');
          await stopped;
          ${hang ? 'await new Promise(() => {});' : ''}
        });
      `;
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(hang ? 1 : 0);
      expect(errors.includes('exiting for supervisor recovery')).toBe(hang);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
