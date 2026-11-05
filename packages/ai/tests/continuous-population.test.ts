import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const continuous of [true, false])
  test(`${continuous ? 'continuous' : 'finite'} population uses the appropriate session policy for all 50 residents`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemwright-continuous-'));
    try {
      const script = `
        import { mock } from 'bun:test';
        const residents = Array.from({length: 50}, (_, index) => ({
          id: String(index), proposedName: 'resident-' + index, templateId: 'miner',
          policyVersion: 1, desiredActive: true,
          checkpoint: { memories: [], relationships: {}, personal: { habits: { offlineUntil: Date.now() + 500 } } }
        }));
        let runs = 0;
        const policies = [];
        mock.module(${JSON.stringify(new URL('../src/run-session.ts', import.meta.url).pathname)}, () => ({
          withRuntime: async (_, body) => body({
            store: { list: () => residents, get: id => residents[Number(id)], template: () => ({ behavior: { activities: ['mine'] } }) },
            stopping: () => runs === 50
          }),
          runResident: async (_, options) => { runs++; policies.push(options.naturalSessions); return {}; }
        }));
        const { runPopulation } = await import(${JSON.stringify(new URL('../src/run-population.ts', import.meta.url).pathname)});
        await runPopulation({ dbPath: ${JSON.stringify(join(directory, 'residents.sqlite'))}, assets: '', staggerSeconds: 0, continuous: ${continuous} });
        console.log(JSON.stringify({runs, policies}));
      `;
      const process = Bun.spawn([Bun.which('bun') ?? 'bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const [output, errors, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited
      ]);
      expect(exit, errors).toBe(0);
      const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
      expect(result.runs).toBe(50);
      expect(result.policies).toEqual(Array(50).fill(!continuous));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
