import { statfs } from 'node:fs/promises';

import type { PlayerSession } from '@gemwright/network/session';

import { executionFor } from './execution-session';
import { PathPool } from './path-pool';
import { perceptionFor } from './perception-session';
import { goalStatus } from './resident-goal';
import { drainSlices } from './stall-probe';
import { actorFor, emitEvent, makeEvent } from './telemetry';
import { runtimeMetrics } from './telemetry-metrics';

export function startRuntimeHealth(options: {
  sessions: ReadonlyMap<string, PlayerSession>;
  directory: string;
  persistence: () => unknown;
  journal: () => unknown;
  intervalMs?: number;
}) {
  let tick = performance.now();
  let closed = false;
  let collecting = false;
  const loop = setInterval(() => {
    const now = performance.now();
    runtimeMetrics.duration('event_loop_lag_ms', Math.max(0, now - tick - 100));
    tick = now;
  }, 100);
  loop.unref();
  const collect = async () => {
    if (collecting || closed) return;
    collecting = true;
    try {
      const disk = await statfs(options.directory).then(
        (value) => ({
          availableBytes: Number(value.bavail) * Number(value.bsize),
          totalBytes: Number(value.blocks) * Number(value.bsize)
        }),
        () => null
      );
      if (closed) return;
      const residents = [...options.sessions].slice(0, 1000).map(([id, session]) => ({
        id,
        ...actorFor(session),
        phase: session.phase,
        goal: goalStatus(session),
        failure: session.failureReason,
        reconnectable: session.reconnectable,
        execution: executionFor(session).arbiter.snapshot(),
        perception: {
          ...perceptionFor(session).stats,
          available: perceptionFor(session).available,
          health: perceptionFor(session).self().health,
          self: perceptionFor(session).self()
        },
        network: session.timing.snapshot(),
        movement: session.movementCounts
      }));
      for (const resident of residents)
        emitEvent(
          makeEvent(
            'runtime',
            'resident_health',
            'observed',
            { ...resident },
            {
              residentId: resident.id,
              name: resident.name,
              sessionId: resident.sessionId,
              traceId: resident.sessionId ?? resident.id,
              position: resident.position
            }
          ),
          { stdout: true }
        );
      const metrics = runtimeMetrics.snapshot();
      emitEvent(makeEvent('runtime', 'runtime_metrics', 'observed', metrics));
      emitEvent(
        makeEvent('runtime', 'runtime_health', 'observed', {
          failures: residents
            .filter((resident) => resident.failure)
            .slice(0, 10)
            .map(({ id, failure, phase }) => ({ id, failure, phase })),
          tracked: options.sessions.size,
          ready: residents.filter((resident) => resident.phase === 'ready').length,
          omittedResidents: Math.max(0, options.sessions.size - residents.length),
          memory: process.memoryUsage(),
          latency: metrics.histograms,
          persistence: options.persistence(),
          journal: options.journal(),
          paths: PathPool.statistics(),
          disk,
          mainThread: drainSlices(),
          durability:
            'journal batches are fsynced before acknowledgement; unacknowledged tail may be lost on process termination',
          retention:
            'life-event history retained; diagnostic traces rotate within 512 MiB with explicit retention records'
        }),
        { stdout: true }
      );
    } finally {
      collecting = false;
    }
  };
  const timer = setInterval(() => {
    void collect().catch((error) =>
      emitEvent(makeEvent('runtime', 'health_collection', 'failed', { reason: String(error) }), { stdout: true })
    );
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return () => {
    closed = true;
    clearInterval(loop);
    clearInterval(timer);
  };
}
