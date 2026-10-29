import { AsyncLocalStorage } from 'node:async_hooks';

import type { PlayerSession } from '@gemwright/network/session';

import { runtimeMetrics } from './telemetry-metrics';
import { redact, type TelemetryEvent, type TraceContext } from './telemetry-schema';

const context = new AsyncLocalStorage<TraceContext>();
const runId = crypto.randomUUID();
let sequence = 0;
let sink: ((event: TelemetryEvent) => void) | undefined;
let output: ((line: string, level: TelemetryEvent['level']) => void) | undefined;
const actors = new WeakMap<PlayerSession, { residentId: string; name: string; sessionId: string }>();
const checkpoints = new WeakMap<object, PlayerSession>();
export function updateTrace(fields: Partial<TraceContext>) {
  const current = context.getStore();
  if (current) Object.assign(current, fields);
}
export const traceContext = () => context.getStore();
export const inTrace = <T>(fields: TraceContext, run: () => T) =>
  context.run({ ...context.getStore(), ...fields }, run);
export function registerActor(session: PlayerSession, residentId: string, name: string) {
  const actor = { residentId, name, sessionId: crypto.randomUUID() };
  actors.set(session, actor);
  return actor;
}
export function actorFor(session: PlayerSession) {
  return {
    ...(actors.get(session) ?? { residentId: null, name: null, sessionId: null }),
    position: session.world.position ? { map: session.world.map, ...session.world.position } : null
  };
}
export const inSession = <T>(session: PlayerSession, run: () => T) => inTrace({ actor: () => actorFor(session) }, run);
export const bindCheckpoint = (checkpoint: object, session: PlayerSession) => checkpoints.set(checkpoint, session);
export const checkpointSession = (checkpoint: object) => checkpoints.get(checkpoint);
export function configureTelemetry(options: {
  sink?: (event: TelemetryEvent) => void;
  output?: (line: string, level: TelemetryEvent['level']) => void;
}) {
  const previous = { sink, output };
  sink = options.sink ?? sink;
  output = options.output ?? output;
  return () => {
    sink = previous.sink;
    output = previous.output;
  };
}
export function makeEvent(
  component: string,
  type: string,
  result: TelemetryEvent['result'],
  details: Record<string, unknown>,
  fields: Partial<TelemetryEvent> = {}
): TelemetryEvent {
  const current = context.getStore();
  const actor = current?.actor?.();
  return {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    runId,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    sequence: ++sequence,
    component,
    message: String(redact(typeof details.message === 'string' ? details.message : `${component}: ${type} ${result}`)),
    level: result === 'failed' ? 'error' : 'info',
    type,
    result,
    residentId: actor?.residentId ?? null,
    name: actor?.name ?? null,
    sessionId: actor?.sessionId ?? null,
    traceId: current?.traceId ?? current?.intentId ?? current?.actionId ?? actor?.sessionId ?? runId,
    intentId: current?.intentId,
    decisionId: current?.decisionId,
    actionId: current?.actionId,
    parentId: current?.parentId,
    position: actor?.position ?? null,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    details: redact(details) as Record<string, unknown>
  };
}
export function emitEvent(event: TelemetryEvent, options: { journal?: boolean; stdout?: boolean } = {}) {
  runtimeMetrics.observe(event);
  if (options.journal !== false) sink?.(event);
  if (options.stdout) output?.(JSON.stringify(event), event.level);
}
export function operational(
  component: string,
  level: TelemetryEvent['level'],
  message: unknown,
  details: Record<string, unknown> = {}
) {
  const event = makeEvent(
    component,
    'operational_log',
    level === 'error' ? 'failed' : 'observed',
    { message, ...details },
    { level }
  );
  emitEvent(event, { stdout: true });
  return event;
}

export function checkpointEvent(
  checkpoint: object,
  component: string,
  type: string,
  result: TelemetryEvent['result'],
  details: Record<string, unknown>,
  fields: Partial<TelemetryEvent> = {}
) {
  const session = checkpointSession(checkpoint);
  emitEvent(makeEvent(component, type, result, details, { ...(session ? actorFor(session) : {}), ...fields }));
}
