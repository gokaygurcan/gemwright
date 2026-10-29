import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { validateConnection } from '../src/connection';
import { ExecutionBoundary } from '../src/execution-boundary';
import { PlayerSession } from '../src/session';
import { waitForUpdate } from '../src/session-observation';
import { UncertainOperation, WaitTimeout } from '../src/wait-options';

const state = () => ({ phase: 'ready', failureReason: null });

test('interruptible waits reject immediately and detach event listeners', async () => {
  const events = new EventEmitter();
  const controller = new AbortController();
  const waiting = waitForUpdate(events, state, () => false, 'any label', 5000, undefined, {
    signal: controller.signal
  });
  controller.abort(new Error('safety'));
  await expect(waiting).rejects.toThrow('safety');
  expect(events.listenerCount('update')).toBe(0);
});

test('atomic wait accepts a late acknowledgement without replaying a command', async () => {
  const events = new EventEmitter();
  const controller = new AbortController();
  let received = false;
  const waiting = waitForUpdate(events, state, () => received, 'transfer', 1000, undefined, {
    signal: controller.signal,
    interruptible: false,
    atomicGraceMs: 50
  });
  controller.abort();
  received = true;
  events.emit('update');
  await waiting;
  expect(events.listenerCount('update')).toBe(0);
});

test('unknown atomic results require reconnection; ordinary timeouts remain local', async () => {
  const config = validateConnection({
    schemaVersion: 1,
    shardId: 'test',
    emulator: 'servuo',
    profile: 'classic-7.0.45.1',
    host: 'localhost',
    port: 2593,
    serverIndex: 0,
    timeoutMs: 1000
  });
  const session = new PlayerSession(config);
  session.phase = 'ready';
  await expect(session.waitFor(() => false, 'opaque label', 10, { interruptible: false })).rejects.toBeInstanceOf(
    UncertainOperation
  );
  expect(String(session.phase)).toBe('failed');
  expect(session.reconnectable).toBe(true);
  expect(session.signal.aborted).toBe(true);
  await expect(waitForUpdate(new EventEmitter(), state, () => false, 'ordinary', 10)).rejects.toBeInstanceOf(
    WaitTimeout
  );
});

test('atomic cancellation has a bounded grace period and predicate failures are contained', async () => {
  const events = new EventEmitter();
  const controller = new AbortController();
  const waiting = waitForUpdate(events, state, () => false, 'transfer', 5000, undefined, {
    signal: controller.signal,
    interruptible: false,
    atomicGraceMs: 10
  });
  controller.abort();
  await expect(waiting).rejects.toBeInstanceOf(UncertainOperation);
  await expect(
    waitForUpdate(
      events,
      state,
      () => {
        throw new Error('bad predicate');
      },
      'predicate',
      100
    )
  ).rejects.toThrow('bad predicate');
  expect(events.listenerCount('update')).toBe(0);
});

test('explicit wait metadata controls interruption, independently of labels', async () => {
  const boundary = new ExecutionBoundary();
  const events = new EventEmitter();
  const controller = new AbortController();
  let settled = 0;
  boundary.setContext((options) => {
    expect(options.resource).toBe('target');
    return { signal: controller.signal, settled: () => settled++ };
  });
  const waiting = boundary.wait(events, state, () => false, 'movement acknowledgement', 1000, { resource: 'target' });
  controller.abort(new Error('interrupt'));
  await expect(waiting).rejects.toThrow('interrupt');
  expect(settled).toBe(1);
});
