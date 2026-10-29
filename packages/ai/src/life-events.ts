import { AsyncLocalStorage } from 'node:async_hooks';

import type { PlayerSession } from '@gemwright/network/session';

import { residentTerrain } from './resident-context';
import { actorFor, emitEvent, inTrace, makeEvent, registerActor, traceContext } from './telemetry';
import type { TelemetryEvent } from './telemetry-schema';

export interface LifeEvent extends TelemetryEvent {
  residentId: string;
  name: string;
  sessionId: string;
}

interface Recorder {
  residentId: string;
  name: string;
  sessionId: string;
  write: (event: LifeEvent) => void;
}
const recorders = new WeakMap<PlayerSession, Recorder>();
const targets = new WeakMap<PlayerSession, { serial: number; at: number }>();
export const noteLifeTarget = (session: PlayerSession, serial: number) =>
  targets.set(session, { serial, at: Date.now() });
export const currentLifeTarget = (session: PlayerSession) => {
  const target = targets.get(session);
  return target && Date.now() - target.at < 30_000 ? target.serial : undefined;
};
const actions = new AsyncLocalStorage<{ session: PlayerSession; id: string }>();

export function registerLifeEvents(
  session: PlayerSession,
  residentId: string,
  name: string,
  write: (event: LifeEvent) => void
) {
  const actor = registerActor(session, residentId, name);
  recorders.set(session, { ...actor, write });
  lifeEvent(session, 'session', 'started', {});
}

export function lifeEvent(
  session: PlayerSession,
  type: string,
  result: LifeEvent['result'],
  details: Record<string, unknown>,
  actionId?: string
) {
  const recorder = recorders.get(session);
  if (!recorder) return;
  const context = actions.getStore();
  const parentId = context?.session === session && context.id !== actionId ? context.id : undefined;
  const intent = details.intent as { id?: string } | undefined;
  const intentId = intent?.id ?? (typeof details.intentId === 'string' ? details.intentId : traceContext()?.intentId);
  const component = type.startsWith('perception_')
    ? 'perception'
    : type === 'action_lifecycle'
      ? 'execution'
      : type === 'goal'
        ? 'planning'
        : 'resident';
  const event = makeEvent(component, type, result, details, {
    intentId,
    ...actorFor(session),
    residentId: recorder.residentId,
    name: recorder.name,
    sessionId: recorder.sessionId,
    actionId: actionId ?? traceContext()?.actionId,
    parentId: parentId ?? traceContext()?.parentId,
    traceId: intentId ?? traceContext()?.traceId ?? actionId ?? recorder.sessionId
  }) as LifeEvent;
  emitEvent(event, { journal: false });
  recorder.write(event);
}

export function entityDetails(session: PlayerSession, serial: number) {
  const entity = session.world.entities.get(serial);
  return entity
    ? {
        serial,
        name:
          entity.name ??
          (entity.kind === 'item' ? residentTerrain(session)?.tile(entity.graphic, true).name : null) ??
          null,
        kind: entity.kind,
        graphic: entity.graphic,
        amount: entity.amount ?? 1,
        parent: entity.parent ?? null,
        layer: entity.layer ?? null,
        hue: entity.hue ?? 0,
        position: entity.position ? { ...entity.position } : null
      }
    : { serial, observed: false };
}
export function beginLifeAction(session: PlayerSession, type: string, details: Record<string, unknown>) {
  const id = crypto.randomUUID();
  const started = performance.now();
  let finished = false;
  lifeEvent(session, type, 'started', details, id);
  return {
    id,
    run<T>(action: () => T): T {
      return actions.run({ session, id }, () =>
        inTrace({ actionId: id, parentId: traceContext()?.actionId, traceId: traceContext()?.traceId ?? id }, action)
      );
    },
    finish(result: Exclude<LifeEvent['result'], 'started'>, outcome: Record<string, unknown> = {}) {
      if (finished) return;
      finished = true;
      lifeEvent(
        session,
        type,
        result,
        { ...details, ...outcome, elapsedMs: Math.round(performance.now() - started) },
        id
      );
    }
  };
}

export async function recordLifeAction<T>(
  session: PlayerSession,
  type: string,
  details: Record<string, unknown>,
  run: () => Promise<T>
): Promise<T> {
  const action = beginLifeAction(session, type, details);
  try {
    const value = await action.run(run);
    action.finish('completed');
    return value;
  } catch (error) {
    action.finish('failed', { reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
