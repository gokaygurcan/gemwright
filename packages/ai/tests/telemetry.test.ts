import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { EventReplay, replayFiles } from '../src/event-replay';
import { actionScope, installExecution } from '../src/execution-session';
import { registerLifeEvents } from '../src/life-events';
import { openLifeJournal } from '../src/life-journal';
import { openPersistence } from '../src/persistence';
import { configureTelemetry, emitEvent, inSession, inTrace, makeEvent, operational } from '../src/telemetry';
import { startRuntimeHealth } from '../src/telemetry-health';
import { RuntimeMetrics } from '../src/telemetry-metrics';
import { observePerception } from '../src/telemetry-perception';
import type { TelemetryEvent } from '../src/telemetry-schema';
import { behaviorFixture } from './behavior-fixture';

const fixture = () => {
  const f = behaviorFixture();
  f.world.connected = true;
  const events: TelemetryEvent[] = [];
  registerLifeEvents(f.session, 'resident-1', 'Resident', (event) => events.push(event));
  return { ...f, events };
};

test('parallel resident traces preserve actor, intent and parents across awaits and redact secrets', async () => {
  const events: TelemetryEvent[] = [];
  const restore = configureTelemetry({ sink: (event) => events.push(event) });
  try {
    const residents = [fixture(), fixture()];
    await Promise.all(
      residents.map((f, index) =>
        inSession(f.session, () =>
          inTrace(
            { intentId: `intent-${index}`, actionId: `action-${index}`, traceId: `intent-${index}` },
            async () => {
              await Bun.sleep(index + 1);
              operational('vendor', 'warn', 'refused token=private Bearer private', {
                password: 'private',
                nested: { apiKey: 'private' }
              });
            }
          )
        )
      )
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.sessionId)).size).toBe(2);
    for (const [index, event] of events.entries()) {
      expect(event.intentId).toBe(`intent-${index}`);
      expect(event.actionId).toBe(`action-${index}`);
      expect(event.component).toBe('vendor');
      expect(event.level).toBe('warn');
      expect(event.position).toMatchObject({ x: 100, y: 100 });
      expect(JSON.stringify(event)).not.toContain('private');
    }
    expect(events[1]?.sequence).toBe((events[0]?.sequence ?? 0) + 1);
    expect(makeEvent('test', 'outside', 'observed', {}).sessionId).toBeNull();
  } finally {
    restore();
  }
});

test('execution correlates authorization, dispatch and observed outcome', async () => {
  const f = fixture();
  const arbiter = installExecution(f.session);
  try {
    await inSession(f.session, () =>
      inTrace({ intentId: 'earn-1', traceId: 'earn-1' }, () =>
        actionScope(f.session, 'work', 'earn', async () => {
          await arbiter.execute(
            { name: 'use', args: [42], resources: [], async: true, atomic: false, confirmed: true },
            async () => {}
          );
        })
      )
    );
    const lifecycle = f.events.filter((event) => event.type === 'action_lifecycle' && event.details.command === 'use');
    expect(lifecycle.map((event) => event.result)).toEqual([
      'proposed',
      'authorized',
      'dispatched',
      'observed',
      'completed'
    ]);
    expect(new Set(lifecycle.map((event) => event.actionId)).size).toBe(1);
    expect(lifecycle.every((event) => event.intentId === 'earn-1')).toBe(true);
  } finally {
    f.session.signal?.dispatchEvent(new Event('abort'));
    arbiter.close();
  }
});

test('decoded observations replay state, removals and unknowns without inventing outcomes', () => {
  const f = fixture();
  const stop = observePerception(f.session);
  try {
    f.world.ready = true;
    f.world.apply(Buffer.from([0x72, 0, 0, 0, 0]));
    const packet = Buffer.alloc(13);
    packet[0] = 0xaf;
    packet.writeUInt32BE(42, 1);
    packet.writeUInt32BE(99, 5);
    f.world.apply(packet);
    const replay = new EventReplay();
    for (const event of f.events) replay.accept(event);
    const state = replay.sessions.values().next().value;
    expect(state?.self.health).toMatchObject({ kind: 'observed', value: { current: 100 } });
    expect(
      replay.timeline.some(
        (event) => event.details.events && JSON.stringify(event.details.events).includes('entity-death')
      )
    ).toBe(true);
    expect(JSON.stringify(replay.summary())).not.toContain('creditedKill":true');
    expect(state?.entities.has(10)).toBe(true);
  } finally {
    stop();
  }
});

test('streaming replay handles concatenated gzip, duplicate IDs, gaps, legacy records and damaged tails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-replay-'));
  try {
    const a = makeEvent('test', 'one', 'observed', {});
    const b = makeEvent('test', 'two', 'failed', {});
    const file = join(directory, 'events.jsonl.gz');
    await writeFile(file, Buffer.concat([gzipSync(`${JSON.stringify(a)}\n`), gzipSync(`${JSON.stringify(b)}\n`)]));
    const summary = await replayFiles([file]);
    expect(summary.matched).toBe(2);
    expect(summary.issues.incompleteInput).toBe(0);
    const replay = new EventReplay({ limit: 1 });
    replay.accept(a);
    replay.accept(a);
    replay.accept({ ...b, sequence: b.sequence + 2 });
    replay.accept({ schemaVersion: 1 });
    replay.accept('invalid');
    expect(replay.summary().issues).toMatchObject({ duplicate: 1, gaps: 2, legacy: 1, malformed: 1, omitted: 1 });
    expect(replay.summary().replayComplete).toBe(false);
    const bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, bytes.length - 6));
    expect((await replayFiles([file])).issues.incompleteInput).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('metrics and retained timelines stay bounded under high-cardinality input', () => {
  const metrics = new RuntimeMetrics();
  const replay = new EventReplay({ limit: 10 });
  for (let i = 0; i < 10000; i++) {
    metrics.increment(`entity-${i}`);
    metrics.duration(`latency-${i}`, i);
    replay.accept(makeEvent('test', `event-${i}`, 'observed', {}));
  }
  expect(Object.keys(metrics.snapshot().counters).length).toBeLessThanOrEqual(513);
  expect(Object.keys(metrics.snapshot().histograms).length).toBeLessThanOrEqual(65);
  expect(replay.timeline).toHaveLength(10);
  expect(Object.keys(replay.counts).length).toBeLessThanOrEqual(513);
});

test('population event load keeps timers moving and acknowledges journal and state durability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-telemetry-load-'));
  const errors: Error[] = [];
  const journal = await openLifeJournal(directory, (error) => errors.push(error));
  const persistence = await openPersistence(join(directory, 'residents.sqlite'), 'load-test', (error) =>
    errors.push(error)
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const restore = configureTelemetry({ sink: journal.append });
  const sessions = new Map<string, ReturnType<typeof fixture>['session']>();
  const stop = startRuntimeHealth({
    sessions,
    directory,
    journal: journal.statistics,
    persistence: persistence.statistics,
    intervalMs: 20
  });
  try {
    persistence.database.exec('CREATE TABLE IF NOT EXISTS telemetry_load (id TEXT PRIMARY KEY, value INTEGER)');
    for (let turn = 0; turn < 20; turn++) {
      for (let resident = 0; resident < 109; resident++) {
        const event = makeEvent(
          'load',
          'perception_delta',
          'observed',
          { entities: Array.from({ length: 10 }, (_, serial) => ({ serial, position: { x: turn, y: resident } })) },
          { residentId: String(resident) }
        );
        emitEvent(event);
        persistence.database.query('INSERT OR REPLACE INTO telemetry_load VALUES (?, ?)').run(String(resident), turn);
      }
      await Bun.sleep(5);
    }
    stop();
    await Promise.all([journal.flush(), persistence.flush()]);
    expect(ticks).toBeGreaterThan(10);
    expect(journal.statistics().pendingBytes).toBe(0);
    expect(journal.statistics().committed).toBe(journal.statistics().submitted);
    expect(persistence.statistics().committed).toBe(persistence.statistics().submitted);
    expect(persistence.database.query('SELECT count(*) AS n FROM telemetry_load WHERE value=19').get()).toEqual({
      n: 109
    });
    expect(errors).toEqual([]);
  } finally {
    stop();
    restore();
    clearInterval(timer);
    await journal.close();
    await persistence.close();
    persistence.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test('service console and component logs use JSON while standalone CLI output stays plain', async () => {
  const module = new URL('../src/log.ts', import.meta.url).href;
  const structured = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {logToStdout,logger} from ${JSON.stringify(module)}; logToStdout(); logger('bank').info('deposit', {amount: 10}); console.warn('warning'); console.error('failure');`
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(structured.stdout).text(),
    new Response(structured.stderr).text(),
    structured.exited
  ]);
  expect(code).toBe(0);
  const events = [...stdout.trim().split('\n'), ...stderr.trim().split('\n')].map(
    (line) => JSON.parse(line) as TelemetryEvent
  );
  expect(events.map((event) => event.level)).toEqual(['info', 'warn', 'error']);
  expect(events[0]).toMatchObject({ schemaVersion: 2, component: 'bank', message: 'deposit', details: { amount: 10 } });
  expect(events.every((event) => event.traceId && event.runId && event.id)).toBe(true);
  const cli = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {logger} from ${JSON.stringify(module)}; console.log('report'); logger('test').info('plain');`
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await new Response(cli.stdout).text()).toBe('report\n');
  expect(await new Response(cli.stderr).text()).toBe('plain\n');
  expect(await cli.exited).toBe(0);
});

test('resident health telemetry exposes observed status and the reason work is blocked', async () => {
  const f = fixture();
  const { registerGoal, chooseGoal } = await import('../src/resident-goal');
  Reflect.set(f.session, 'timing', { snapshot: () => ({}) });
  registerGoal(f.session, f.checkpoint);
  chooseGoal(f.checkpoint, {
    safe: true,
    ready: true,
    learning: false,
    earningNeeded: true,
    evidence: { funds: 0, bankKnown: true, gold: 0, products: 0, orders: 0, goods: 10, skills: {}, health: 100 },
    planning: {
      condition: 'assets',
      available: true,
      riskTolerance: 0,
      exposed: 2000,
      securable: 2000,
      escapeKnown: false,
      uncertainty: 0.2,
      deathRisk: 0.05
    }
  });
  const events: TelemetryEvent[] = [];
  const restore = configureTelemetry({ sink: (event) => events.push(event) });
  const stop = startRuntimeHealth({
    sessions: new Map([['resident-1', f.session]]),
    directory: tmpdir(),
    persistence: () => ({}),
    journal: () => ({}),
    intervalMs: 5
  });
  try {
    const until = Date.now() + 1000;
    while (!events.some((event) => event.type === 'resident_health') && Date.now() < until) await Bun.sleep(5);
    const event = events.find((event) => event.type === 'resident_health');
    expect(event?.details).toMatchObject({
      perception: {
        self: {
          health: { kind: 'observed', value: { current: 100, max: 100 } },
          mana: { kind: 'observed' },
          stamina: { kind: 'observed' },
          weight: { kind: 'observed' }
        }
      },
      goal: { assessment: { safe: true, reason: 'risk-over-budget', exposed: 2000, deathRisk: 0.05 } }
    });
  } finally {
    stop();
    restore();
  }
});
