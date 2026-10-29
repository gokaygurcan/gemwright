import { dirname, join } from 'node:path';

import type { PlayerSession } from '@gemwright/network/session';

import { markResidents } from './activity';
import { installExecution } from './execution-session';
import { loadLasting, saveLasting } from './lasting';
import { observeLifeActions } from './life-actions';
import { registerLifeEvents } from './life-events';
import { openLifeJournal } from './life-journal';
import { logger } from './log';
import { RuntimeOwnership } from './ownership';
import { PathPool } from './path-pool';
import { startPerception } from './perception-session';
import { openPersistence } from './persistence';
import type { ResidentOptions, RuntimeShared } from './run-session';
import { ResidentStore } from './store';
import { configureTelemetry } from './telemetry';
import { startRuntimeHealth } from './telemetry-health';
import { observePerception } from './telemetry-perception';
import { reportTrouble } from './trouble';

// Opens the store, takes the single shard lease, and closes every tracked session on SIGINT,
// SIGTERM, or a lost lease. One runtime process may drive one or many residents.
export async function withRuntime<T>(
  options: Pick<ResidentOptions, 'population' | 'connection' | 'dbPath'>,
  body: (shared: RuntimeShared) => Promise<T>
): Promise<T | { stoppedBySignal: true }> {
  if (options.population.shardId !== options.connection.shardId)
    throw new Error('Connection and population belong to different shards');
  let persistenceFailure: Error | undefined;
  let stopOnFailure = () => {};
  const persistence = await openPersistence(options.dbPath, options.population.shardId, (error) => {
    persistenceFailure = error;
    logger('runtime').error(`[persistence] ${error.message}`);
    stopOnFailure();
  });
  const journal = await openLifeJournal(join(dirname(options.dbPath), 'life-events'), (error) => {
    logger('runtime').error(`[life-events] ${error.message}`);
    stopOnFailure();
  }).catch(async (error) => {
    await persistence.close();
    throw error;
  });
  const store = new ResidentStore(options.dbPath, options.population.shardId, persistence.database, persistence.flush);
  const sessions = new Map<string, PlayerSession>();
  const restoreTelemetry = configureTelemetry({ sink: journal.append });
  const stopHealth = startRuntimeHealth({
    sessions,
    directory: dirname(options.dbPath),
    persistence: persistence.statistics,
    journal: journal.statistics
  });
  const activity = store.activityRecorder();
  // Reports are never worth a resident: a failed save is logged and skipped.
  loadLasting(store.metadata('lasting'));
  const recordActivity = () => {
    try {
      activity.save(sessions);
      store.setMetadata('lasting', saveLasting());
      reportTrouble();
    } catch (error) {
      logger('runtime').error(`[activity] save failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const saveActivity = setInterval(recordActivity, 5 * 60_000);
  let ownership: RuntimeOwnership | null = null;
  let stopping = false;
  const controller = new AbortController();
  let shutdown: ReturnType<typeof setTimeout> | undefined;
  const closeAll = () => {
    for (const session of sessions.values()) session.close();
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // A stuck behavior must not leave a live container with no population after lease loss.
    shutdown = setTimeout(() => {
      logger('runtime').error('[runtime] Shutdown exceeded 30 seconds; exiting for supervisor recovery');
      process.exit(1);
    }, 30_000);
    shutdown.unref();
    controller.abort();
    closeAll();
  };
  stopOnFailure = stop;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (persistenceFailure) throw persistenceFailure;
    ownership = new RuntimeOwnership(store, stop, store.flush);
    store.reconcile(options.population);
    markResidents(store.list().flatMap((r) => (r.binding ? [Number(r.binding.characterSerial)] : [])));
    await store.flush();
    return await body({
      store,
      signal: controller.signal,
      ownership,
      stopping: () => stopping,
      track: (id, session) => {
        if (session) {
          const resident = store.get(id);
          registerLifeEvents(session, id, resident?.proposedName ?? id, journal.append);
          observeLifeActions(session);
          startPerception(session);
          observePerception(session);
          installExecution(session);
          if (session.world.serial != null) markResidents([session.world.serial]);
        }
        const previous = sessions.get(id);
        if (previous && previous !== session) activity.collect(id, previous);
        if (session) sessions.set(id, session);
        else sessions.delete(id);
      }
    });
  } catch (error) {
    if (stopping) return { stoppedBySignal: true };
    throw error;
  } finally {
    stopHealth();
    clearInterval(saveActivity);
    if (ownership) recordActivity();
    closeAll();
    PathPool.closeAll();
    try {
      ownership?.close();
    } catch {
      logger('runtime').error('[persistence] Could not release the runtime lease');
    }
    try {
      try {
        await journal.close();
      } finally {
        await persistence.close();
      }
    } finally {
      restoreTelemetry();
      store.close();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      clearTimeout(shutdown);
    }
  }
}
