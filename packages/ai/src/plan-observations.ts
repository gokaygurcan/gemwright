import type { PlayerSession } from '@gemwright/network/session';

import { lifeEvent } from './life-events';
import { perceptionFor } from './perception-session';
import { rememberPlan } from './plan-memory';
import type { GoalSituation } from './resident-goal';
import type { Checkpoint } from './store';

interface ObservationBinding {
  checkpoint: Checkpoint;
  situation: () => GoalSituation;
  persist: () => void;
}
const watching = new WeakMap<PlayerSession, ObservationBinding>();
export function observePlans(session: PlayerSession, binding: ObservationBinding) {
  const already = watching.has(session);
  watching.set(session, binding);
  if (already) return;
  // Ensure perception receives each decoded packet before the plan outcome observer does.
  const model = perceptionFor(session);
  const stop = session.world.observations.subscribe(
    () => {
      const current = watching.get(session);
      const life = model.self().life;
      if (!current || life.kind !== 'observed' || life.value !== 'dead') return;
      const goal = current.checkpoint.workGoal?.suspended ?? current.checkpoint.workGoal?.active;
      if (!goal || goal.kind === 'recover') return;
      const previous = current.checkpoint.workGoal?.outcomes?.find((event) => event.id === goal.intent?.id);
      const state = current.situation();
      const wealth =
        goal.before.bankKnown === state.evidence.bankKnown ? state.evidence.funds - goal.before.funds : null;
      if (previous?.result === 'died' && previous.wealth === wealth) return;
      rememberPlan(current.checkpoint, goal, 'died', 'Death observed while the intent was active', state);
      current.persist();
    },
    (error) => lifeEvent(session, 'planning_observation', 'failed', { reason: String(error) })
  );
  session.signal?.addEventListener(
    'abort',
    () => {
      stop();
      watching.delete(session);
    },
    { once: true }
  );
}
