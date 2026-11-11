import type { PlayerSession } from '@gemwright/network/session';

import { lifeEvent } from './life-events';
import { Perception } from './perception';

const models = new WeakMap<PlayerSession, Perception>();
export function perceptionFor(session: PlayerSession): Perception {
  const existing = models.get(session);
  if (existing) return existing;
  let refreshing = false;
  let retryAt = 0;
  const model = new Perception(session.world, {
    onError: (error) =>
      lifeEvent(session, 'perception_failure', 'failed', {
        reason: error instanceof Error ? error.message : String(error)
      }),
    onReconcile: () => {
      // A model whose observation stream failed retries on the reconciliation tick; a model that
      // keeps failing simply fails again.
      if (session.phase === 'ready' && !model.available) model.revive();
      if (
        session.phase !== 'ready' ||
        refreshing ||
        Date.now() < retryAt ||
        Date.now() - (session.world.observations.fieldAt.get('weight') ?? 0) < 30_000
      )
        return;
      refreshing = true;
      retryAt = Date.now() + 30_000;
      void session
        .refreshStatus()
        .catch((error) => {
          if (session.phase === 'ready')
            lifeEvent(session, 'perception_reconcile', 'failed', {
              reason: error instanceof Error ? error.message : String(error)
            });
        })
        .finally(() => {
          refreshing = false;
        });
    }
  });
  models.set(session, model);
  session.signal?.addEventListener('abort', () => model.dispose(), { once: true });
  if (session.signal?.aborted) model.dispose();
  return model;
}

export function startPerception(session: PlayerSession, intervalMs = 5000) {
  const model = perceptionFor(session);
  model.start(intervalMs);
  return model;
}
