import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLifeJournal } from '../src/life-journal';
import { openPersistence } from '../src/persistence';
import {
  configureTelemetry,
  emitEvent,
  inSession,
  inTrace,
  makeEvent,
  operational,
  registerActor
} from '../src/telemetry';
import { startRuntimeHealth } from '../src/telemetry-health';
import { RuntimeMetrics } from '../src/telemetry-metrics';
import type { TelemetryEvent } from '../src/telemetry-schema';
import { behaviorFixture } from './behavior-fixture';

const fixture = () => {
  const f = behaviorFixture();
  f.world.connected = true;
  registerActor(f.session, 'resident-1', 'Resident');
  return f;
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

test('metrics stay bounded under high-cardinality input', () => {
  const metrics = new RuntimeMetrics();
  for (let i = 0; i < 10000; i++) {
    metrics.increment(`entity-${i}`);
    metrics.duration(`latency-${i}`, i);
  }
  expect(Object.keys(metrics.snapshot().counters).length).toBeLessThanOrEqual(513);
  expect(Object.keys(metrics.snapshot().histograms).length).toBeLessThanOrEqual(65);
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
