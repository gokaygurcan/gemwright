import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loopLag } from './activity';
import { decisionReport } from './decisions';
import { info } from './log';
import { type ResidentOptions, runResident, withRuntime } from './run-session';
import { temperamentOf } from './temperament';

// Runs every desired-active resident in this one process under the single shard lease. Logins are
// staggered as real players arrive at different times; each resident has its own session,
// reconnect budget, and behavior supervision, and one resident's failure never stops the others.
export async function runPopulation(
  options: Omit<ResidentOptions, 'minerAssets' | 'fighterAssets' | 'lumberjackAssets' | 'exercise' | 'reconnect'> & {
    assets: string;
    staggerSeconds: number;
    limit?: number;
    // Residents stay online: a finished or failed session logs back in after a pause.
    continuous?: boolean;
  }
) {
  return withRuntime(options, async (shared) => {
    const residents = shared.store
      .list()
      .filter((resident) => resident.desiredActive)
      .slice(0, options.limit);
    const startedAt = new Date().toISOString();
    // Event-loop lag: every resident shares this loop, and a long stall misses movement
    // acknowledgements, keep-alives, and the lease heartbeat for all of them.
    const lag = { max: 0, stalls: 0 };
    let tick = Date.now();
    const monitor = setInterval(() => {
      const late = Date.now() - tick - 1000;
      tick = Date.now();
      lag.max = Math.max(lag.max, late);
      loopLag.max = Math.max(loopLag.max, late);
      if (late > 1500) {
        lag.stalls++;
        loopLag.stalls++;
        console.error(`[population] event loop stalled for ${late} ms`);
      }
    }, 1000);
    const runs = residents.map(async (resident, index) => {
      // Staggered arrival, cut short by shutdown.
      const arriveAt = Date.now() + index * options.staggerSeconds * 1000;
      while (Date.now() < arriveAt && !shared.stopping()) await Bun.sleep(250);
      if (shared.stopping()) return { residentId: resident.id, outcome: 'not-started' as const };
      const template = shared.store.template(resident.templateId, resident.policyVersion);
      const activities = template?.behavior.activities ?? [];
      // Newer professions run through the profession runtime, chosen by the template's activities;
      // world templates name the behavior (`miner`), hand-written ones may name the activity (`mine`).
      const profession = (['tamer', 'thief', 'bard', 'fisher', 'tailor', 'alchemist', 'bowyer'] as const).find(
        (behavior) => activities.includes(behavior)
      );
      const role =
        profession ??
        (activities.includes('miner') || activities.includes('mine')
          ? 'miner'
          : activities.includes('lumberjack') || activities.includes('chop')
            ? 'lumberjack'
            : 'fighter');
      const log = (text: string) => info(`[population] ${resident.proposedName}: ${text}`);
      log(`arriving as ${role}`);
      let failures = 0;
      while (true) {
        const offlineUntil = shared.store.get(resident.id)?.checkpoint.personal?.habits?.offlineUntil ?? 0;
        while (Date.now() < offlineUntil && !shared.stopping()) await Bun.sleep(1000);
        if (shared.stopping()) return { residentId: resident.id, outcome: 'finished' as const };
        try {
          await runResident(
            shared,
            {
              ...options,
              exercise: false,
              reconnect: false,
              naturalSessions: !!options.continuous,
              ...(profession
                ? { profession: { behavior: profession, assets: options.assets } }
                : { [`${role}Assets`]: options.assets })
            },
            resident.id
          );
          log('session finished');
          failures = 0;
          if (!options.continuous || shared.stopping())
            return { residentId: resident.id, outcome: 'finished' as const };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`session failed: ${message}`);
          if (!options.continuous || shared.stopping())
            return { residentId: resident.id, outcome: 'failed' as const, error: message };
          failures++;
        }
        const retryAt = Date.now() + Math.min(15_000 * 2 ** failures, 300_000);
        log('logging back in');
        while (Date.now() < retryAt && !shared.stopping()) await Bun.sleep(250);
        if (shared.stopping()) return { residentId: resident.id, outcome: 'finished' as const };
      }
    });
    const outcomes = await Promise.all(runs);
    clearInterval(monitor);
    // A comparable summary of what each resident actually did, from its persisted checkpoint.
    const summary = shared.store.list().flatMap((resident) => {
      const outcome = outcomes.find((entry) => entry.residentId === resident.id);
      if (!outcome) return [];
      const checkpoint = resident.checkpoint;
      return [
        {
          ...outcome,
          name: resident.proposedName,
          template: resident.templateId,
          serial: resident.binding?.characterSerial ?? null,
          temperament: temperamentOf(resident.id),
          goal: checkpoint.goal,
          funds: checkpoint.funds ?? null,
          stock: checkpoint.stock ?? null,
          mount: checkpoint.mount?.state ?? null,
          decisions: decisionReport(checkpoint.decisions),
          peersSeen: Object.entries(checkpoint.relationships)
            .filter(([, entry]) => entry.peer)
            .map(([name, entry]) => ({ name, seen: entry.seen ?? 0 })),
          recentMemories: checkpoint.memories.slice(-8).map((memory) => memory.text)
        }
      ];
    });
    const report = { startedAt, finishedAt: new Date().toISOString(), eventLoopLagMs: lag, residents: summary };
    const directory = join(dirname(options.dbPath), 'proofs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'population-latest.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  });
}
