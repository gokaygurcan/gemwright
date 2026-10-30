import { type Command, interceptCommands } from '@gemwright/network/commands';
import type { PlayerSession } from '@gemwright/network/session';

import { ActionArbiter, type ActionEvent, type ActionKind, priority } from './action-arbiter';
import { ActionBusy, ActionInterrupted, DangerInterrupt, InteractionInterrupt } from './action-errors';
import type { ResidentIntent } from './intent';
import { lifeEvent } from './life-events';
import { perceptionFor } from './perception-session';
import { intentIsCurrent } from './resident-goal';
import { inTrace, updateTrace } from './telemetry';
import { observeInterruption } from './telemetry-metrics';

interface Execution {
  arbiter: ActionArbiter;
  interactionUntil: number;
  installed: boolean;
  targetOrphaned: boolean;
  targetUntil: number;
  cleanup: () => void;
}
const executions = new WeakMap<PlayerSession, Execution>();
const observeCommands = new Set(['refreshStatus', 'refreshSkills', 'inspect', 'inspectProperties']);
const cleanupCommand = (command: Command) =>
  command.name === 'cancelTrade' ||
  (command.name === 'acceptTrade' && command.args[0] === false) ||
  (command.name === 'target' && command.args[0] === null) ||
  (command.name === 'setWarMode' && command.args[0] === false);

function trace(session: PlayerSession, event: ActionEvent) {
  observeInterruption(session, event);
  // Movement tiles and observation requests stay in bounded runtime history; travel and state
  // observations already have their own journal events.
  if (event.command && (event.command === 'walk' || observeCommands.has(event.command))) return;
  if (
    !event.command &&
    !['proposed', 'authorized', 'dispatched', 'completed', 'failed', 'interrupted', 'timed-out'].includes(event.stage)
  )
    return;
  inTrace(
    {
      traceId: event.intentId ?? event.parentId ?? event.id,
      intentId: event.intentId,
      actionId: event.id,
      parentId: event.parentId
    },
    () =>
      lifeEvent(
        session,
        'action_lifecycle',
        event.stage === 'dispatched' ? 'dispatched' : event.stage,
        { ...event },
        event.id
      )
  );
}

export function executionFor(session: PlayerSession): Execution {
  const existing = executions.get(session);
  if (existing) return existing;
  const state: Execution = {
    arbiter: undefined as unknown as ActionArbiter,
    interactionUntil: 0,
    installed: false,
    targetOrphaned: false,
    targetUntil: 0,
    cleanup: () => {}
  };
  const arbiter = new ActionArbiter({
    emit: (event) => trace(session, event),
    authorize: (scope, command) => {
      if (cleanupCommand(command) || command.resources.length === 0) return;
      if (
        scope.intentId &&
        ['work', 'trade'].includes(scope.kind) &&
        !intentIsCurrent(session, scope.intentId, scope.intentStep)
      )
        throw new ActionInterrupted('Plan changed, blocked or expired; replan before another work command');
      const model = perceptionFor(session);
      if (!model.available) throw new ActionInterrupted('Perception unavailable; reconcile before acting');
      const trade = session.world.trade;
      if (trade && !trade.closed && command.resources.includes('movement') && scope.kind !== 'escape')
        throw new InteractionInterrupt();
      if (
        ((trade && !trade.closed) || state.interactionUntil > Date.now()) &&
        priority[scope.kind] < priority.interaction
      )
        throw new InteractionInterrupt();
      if (state.targetOrphaned && command.resources.includes('target') && !cleanupCommand(command))
        throw new ActionBusy('Waiting for an interrupted targeting cursor to clear');
    },
    interrupted: (scope) => {
      if (scope.waitingTarget > 0 && !session.world.target) {
        state.targetOrphaned = true;
        state.targetUntil = Date.now() + 4000;
      }
    }
  });
  state.arbiter = arbiter;
  executions.set(session, state);
  return state;
}
export const actionKind = (session: PlayerSession) => executions.get(session)?.arbiter.current()?.kind;
export const checkAction = (session: PlayerSession) => executions.get(session)?.arbiter.check();

export const urgentActive = (session: PlayerSession) => {
  const arbiter = executions.get(session)?.arbiter;
  return !!arbiter && (arbiter.activeKind('combat') || arbiter.activeKind('escape'));
};

export function bindIntent(session: PlayerSession, intent?: ResidentIntent) {
  const scope = executions.get(session)?.arbiter.current();
  if (scope) {
    updateTrace({ intentId: intent?.id, traceId: intent?.id ?? scope.id });
    scope.intent = intent?.outcome ?? scope.kind;
    scope.intentId = intent?.id;
    scope.intentStep = intent?.currentStep;
  }
}

export function actionScope<T>(
  session: PlayerSession,
  kind: ActionKind,
  intent: string,
  body: () => Promise<T>,
  ms?: number
): Promise<T> {
  const time =
    ms ??
    {
      work: 600_000,
      recovery: 120_000,
      interaction: 120_000,
      trade: 120_000,
      combat: 90_000,
      escape: 45_000,
      observation: 15_000
    }[kind];
  return executionFor(session).arbiter.run(kind, intent, body, time);
}

export function independentAction<T>(session: PlayerSession, kind: ActionKind, intent: string, body: () => Promise<T>) {
  return executionFor(session).arbiter.run(kind, intent, body, kind === 'trade' ? 120_000 : 60_000, true);
}

export function reserveInteraction(session: PlayerSession, until: number) {
  const state = executionFor(session);
  state.interactionUntil = until;
  if (until > Date.now()) state.arbiter.interruptBelow('interaction', new InteractionInterrupt());
}

export async function yieldForInteraction(session: PlayerSession, error: unknown): Promise<boolean> {
  if (!(error instanceof InteractionInterrupt) && !(error instanceof ActionBusy)) return false;
  const state = executionFor(session);
  const until = Date.now() + (error instanceof ActionBusy ? 500 : 120_000);
  while (session.phase === 'ready' && Date.now() < until) {
    if (perceptionFor(session).underAttack() || perceptionFor(session).damagedRecently()) return true;
    if ((!session.world.trade || session.world.trade.closed) && state.interactionUntil <= Date.now()) break;
    await Bun.sleep(100);
  }
  return true;
}

export function installExecution(session: PlayerSession) {
  const state = executionFor(session);
  if (state.installed) return state.arbiter;
  state.installed = true;
  session.setWaitContext?.((options) => state.arbiter.waitContext(options));
  const restore = interceptCommands(session, (command, invoke) => {
    if (cleanupCommand(command)) {
      state.arbiter.check();
      return invoke();
    }
    return state.arbiter.execute(command, invoke);
  });
  let inspecting = false;
  const stop = session.world.observations.subscribe(
    () => {
      if (inspecting) return;
      inspecting = true;
      try {
        if (session.world.target && state.targetOrphaned) {
          session.target(null);
          state.targetOrphaned = false;
        }
        const model = perceptionFor(session);
        if (model.underAttack() || model.damagedRecently()) {
          let reason: unknown;
          try {
            if (!session.execution?.check()) reason = new DangerInterrupt();
          } catch (error) {
            reason = error;
          }
          if (reason !== undefined) {
            state.interactionUntil = 0;
            state.arbiter.interruptBelow('escape', reason);
            if (session.world.trade && !session.world.trade.closed) session.cancelTrade();
            if (session.world.target && !state.arbiter.activeKind('escape')) session.target(null);
          }
        }
        if (session.world.trade && !session.world.trade.closed)
          state.arbiter.interruptBelow('trade', new InteractionInterrupt());
      } finally {
        inspecting = false;
      }
    },
    (error) => {
      state.arbiter.interruptBelow('escape', error);
      lifeEvent(session, 'execution_observation', 'failed', { reason: String(error) });
    }
  );
  const sweep = setInterval(() => {
    if (session.signal?.aborted) return;
    if (!state.targetOrphaned || Date.now() < state.targetUntil) return;
    // The cursor never arrived. The shard answers a cursor request in one round trip and TCP does
    // not lose that reply, so none was opened: the request was refused or superseded. There is
    // nothing to cancel, and reconnecting would only drop the session. Stop withholding target
    // commands and record the assumption.
    state.targetOrphaned = false;
    lifeEvent(session, 'execution_observation', 'failed', {
      reason: 'Interrupted targeting cursor never arrived; assuming the request was refused'
    });
  }, 100);
  sweep.unref();
  state.cleanup = () => {
    clearInterval(sweep);
    stop();
    restore();
    state.arbiter.close();
  };
  session.signal?.addEventListener('abort', state.cleanup, { once: true });
  return state.arbiter;
}
