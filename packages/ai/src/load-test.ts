import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { validateConfig } from './config';
import { validateConnection } from './connection';
import { PathPool } from './path-pool';
import type { PlayerSession } from './protocol/session';
import { Latency } from './protocol/session-observation';
import { runResident, withRuntime } from './run-session';
import { drainSlices } from './stall-probe';
import { ResidentStore } from './store';
import { Terrain } from './terrain';
import { applyWorld, behaviorOf, professionOf, weightedPick } from './world';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    data: { type: 'string' },
    count: { type: 'string' },
    seconds: { type: 'string' },
    output: { type: 'string' }
  }
});
if (!values.data || !values.output) throw new Error('--data and --output are required');
const count = Number(values.count ?? 50);
const seconds = Number(values.seconds ?? 300);
if (!Number.isInteger(count) || count < 1 || count > 300 || !Number.isFinite(seconds) || seconds < 60 || seconds > 3600)
  throw new Error('Invalid load-test bounds');
const data = resolve(values.data);
const output = resolve(values.output);
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFileSync(`${output}/${name}`, JSON.stringify(value, null, 2), { mode: 0o600 });
const append = (name: string, value: unknown) =>
  appendFileSync(`${output}/${name}`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const original = validateConfig(await Bun.file(`${data}/population.json`).json());
// The population comes from the world configuration (world/world.json): professions, homes, mix.
const population = applyWorld(structuredClone(original), count);
validateConfig(population);
save('population.json', population);
const sourceRoot = resolve(import.meta.dir);
const sources = readdirSync(sourceRoot, { recursive: true }).filter(
  (name) => typeof name === 'string' && name.endsWith('.ts')
) as string[];
save('provenance.json', {
  sources: Object.fromEntries(
    sources.map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(resolve(sourceRoot, name)))
        .digest('hex')
    ])
  ),
  huffman: createHash('sha256')
    .update(readFileSync(resolve('packages/common/src/huffman.ts')))
    .digest('hex')
});
const connection = validateConnection(await Bun.file(`${data}/connection.json`).json());
const options = { population, connection, dbPath: `${data}/residents.sqlite` };
const sessions = new Map<string, PlayerSession>();
const lag = new Latency();
const steadyLag = new Latency();
let started = 0;
let deadline = 0;
let peakReady = 0;
let peakRss = 0;
let stopping = false;
let monitor: ReturnType<typeof setInterval> | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;
let cutoff: ReturnType<typeof setTimeout> | undefined;
const outcomes: unknown[] = [];
const completedTimings: unknown[] = [];
const assignments = new Map<string, { role: string; name: string }>();
let result: unknown;
try {
  result = await withRuntime(options, async (shared) => {
    const terrain = Terrain.shared(`${data}/assets`, 1);
    await terrain.pathAsync({ x: 1434, y: 1694, z: 0 }, { x: 1435, y: 1694 }, 0);
    const residents = shared.store.list().filter((r) => r.desiredActive);
    const grounds = ['Britain', 'Yew', 'Vesper', 'Jhelom', 'Moonglow', 'Cove'];
    let fighter = 0;
    for (const r of residents) {
      const role =
        behaviorOf(r.templateId) ??
        (r.templateId.includes('miner') ? 'miner' : r.templateId.includes('lumberjack') ? 'lumberjack' : 'fighter');
      assignments.set(r.id, { role, name: r.proposedName });
      if (role === 'fighter') {
        const cp = structuredClone(r.checkpoint);
        cp.hunting ??= { loot: [], killsSinceBank: 0, pending: 'hunt' };
        // Each fighter starts at a ground its profession favours (weighted, see world.json).
        const favoured = professionOf(r.templateId)?.[1].grounds;
        cp.hunting.ground = (favoured && weightedPick(favoured, r.id)) ?? grounds[fighter++ % grounds.length];
        shared.store.saveProgress(r.id, r.revision, cp, r.binding);
      }
    }
    save('assignments.json', Object.fromEntries(assignments));
    save('before.json', shared.store.list());
    const tracked = {
      ...shared,
      track: (id: string, session: PlayerSession | null) => {
        if (session) sessions.set(id, session);
        else {
          const last = sessions.get(id);
          if (last) {
            completedTimings.push({ id, ...last.timing.snapshot() });
            save(`last-${id}.json`, {
              at: new Date().toISOString(),
              phase: last.phase,
              failure: last.failureReason,
              movement: last.movementCounts,
              latency: last.timing.snapshot(),
              world: last.world.snapshot()
            });
          }
          sessions.delete(id);
        }
        shared.track(id, session);
      }
    };
    started = Date.now();
    deadline = started + seconds * 1000;
    const warmup = count * 750 + 15000;
    save('timing.json', {
      startedAt: new Date(started).toISOString(),
      deadline: new Date(deadline).toISOString(),
      warmupMs: warmup,
      count,
      seconds,
      pid: process.pid
    });
    let tick = performance.now();
    let heap = process.memoryUsage().heapUsed;
    monitor = setInterval(() => {
      const now = performance.now();
      const late = Math.max(0, now - tick - 10);
      tick = now;
      lag.record(late);
      // What ran since the previous tick; a heap drop marks a collection inside the stall.
      const slices = drainSlices();
      const heapNow = process.memoryUsage().heapUsed;
      const heapDeltaMB = +((heapNow - heap) / 2 ** 20).toFixed(1);
      heap = heapNow;
      if (late > 20) append('lag-spikes.ndjson', { at: new Date().toISOString(), lateMs: late, heapDeltaMB, slices });
      if (Date.now() > started + warmup) steadyLag.record(late);
    }, 10);
    const capture = () => {
      const live = [...sessions].map(([id, s]) => ({
        id,
        ...assignments.get(id),
        phase: s.phase,
        error: s.failureReason,
        position: s.world.position,
        status: s.world.status,
        latency: s.timing.snapshot(),
        movement: { ...s.movementCounts },
        entities: s.world.entities.size
      }));
      const ready = live.filter((r) => r.phase === 'ready').length;
      peakReady = Math.max(peakReady, ready);
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      append('telemetry.ndjson', {
        at: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        shuttingDown: stopping,
        ready,
        tracked: sessions.size,
        finished: outcomes.length,
        memory,
        lag: lag.snapshot(),
        steadyLag: steadyLag.snapshot(),
        paths: PathPool.statistics(),
        live
      });
      console.error(
        `[load] count=${count} ready=${ready} finished=${outcomes.length} rssMB=${Math.round(memory.rss / 1e6)} steadyLag=${JSON.stringify(steadyLag.snapshot())}`
      );
    };
    sampler = setInterval(capture, 5000);
    cutoff = setTimeout(() => {
      stopping = true;
      if (monitor) clearInterval(monitor);
      if (sampler) clearInterval(sampler);
      capture();
      process.kill(process.pid, 'SIGTERM');
    }, seconds * 1000);
    const ordered = residents.sort((a, b) => a.ordinal - b.ordinal || a.templateId.localeCompare(b.templateId));
    await Promise.all(
      ordered.map(async (r, index) => {
        while (Date.now() < started + index * 750 && !shared.stopping()) await Bun.sleep(100);
        if (shared.stopping()) return;
        const role = assignments.get(r.id)?.role ?? 'fighter';
        append('lifecycle.ndjson', { at: new Date().toISOString(), id: r.id, event: 'start', role });
        try {
          const residentResult = await runResident(
            tracked,
            {
              ...options,
              create: true,
              exercise: false,
              reconnect: false,
              reconnectAttempts: 3,
              durationSeconds: Math.max(0, (deadline - Date.now()) / 1000),
              ...(['miner', 'lumberjack', 'fighter'].includes(role)
                ? { [`${role}Assets`]: `${data}/assets` }
                : { profession: { behavior: role as 'fisher', assets: `${data}/assets` } })
            },
            r.id
          );
          const outcome = { id: r.id, event: 'end', at: new Date().toISOString(), result: residentResult };
          outcomes.push(outcome);
          save(`resident-${r.id}.json`, residentResult);
          append('lifecycle.ndjson', {
            ...outcome,
            result: {
              mining: residentResult.mining,
              hunting: residentResult.hunting,
              lumber: residentResult.lumber,
              profession: residentResult.profession,
              recoveryAttempts: residentResult.recoveryAttempts
            }
          });
        } catch (error) {
          const outcome = {
            id: r.id,
            event: 'failure',
            at: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
          };
          outcomes.push(outcome);
          append('lifecycle.ndjson', outcome);
        }
      })
    );
    while (Date.now() < deadline && !shared.stopping()) await Bun.sleep(100);
    capture();
    save('after.json', shared.store.list());
    return {
      count,
      seconds,
      startedAt: new Date(started).toISOString(),
      deadline: new Date(deadline).toISOString(),
      finishedAt: new Date().toISOString(),
      peakReady,
      peakRss,
      lag: lag.snapshot(),
      steadyLag: steadyLag.snapshot(),
      timings: completedTimings,
      paths: PathPool.statistics(),
      outcomes
    };
  });
} finally {
  if (monitor) clearInterval(monitor);
  if (sampler) clearInterval(sampler);
  if (cutoff) clearTimeout(cutoff);
  const store = new ResidentStore(options.dbPath, original.shardId);
  const allocation = store.reconcile(original);
  store.close();
  save('shutdown.json', { at: new Date().toISOString(), remainingSessions: sessions.size, stopping, allocation });
}
save('result.json', result);
