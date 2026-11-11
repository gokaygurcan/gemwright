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
          if (template.id === 'britain-miner') template.creation.cities = { Britain: 1 };
        }
        const timeout = globalThis.setTimeout;
        const clear = globalThis.clearTimeout;
        let watchdog;
        let expire;
        let cancelled = false;
        globalThis.setTimeout = (fn, ms, ...args) => {
          const timer = timeout(fn, ms, ...args);
          if (ms === 30000) {
            watchdog = timer;
            expire = () => fn(...args);
            console.log('watchdog armed: ' + ms);
          }
          return timer;
        };
        globalThis.clearTimeout = (timer) => {
          if (timer === watchdog) cancelled = true;
          clear(timer);
        };
        await withRuntime({
          dbPath: ${JSON.stringify(join(directory, 'residents.sqlite'))},
          population,
          connection: { shardId: population.shardId }
        }, async (shared) => {
          const stopped = new Promise(resolve => shared.signal.addEventListener('abort', resolve, { once: true }));
          process.kill(process.pid, 'SIGTERM');
          await stopped;
          if (!expire) throw new Error('Shutdown watchdog was not armed');
          ${hang ? 'queueMicrotask(expire); await new Promise(() => {});' : ''}
        });
        if (!cancelled) throw new Error('Shutdown watchdog was not cancelled');
      `;
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ]);
      expect(output.trim()).toBe('watchdog armed: 30000');
      expect(code).toBe(hang ? 1 : 0);
      expect(errors.includes('exiting for supervisor recovery')).toBe(hang);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
