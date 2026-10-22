import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { appearanceOf } from './appearance';
import { runBard } from './bard';
import { superviseBehavior } from './behavior-supervisor';
import type { PopulationConfig } from './config';
import type { ConnectionConfig } from './connection';
import { connectionAdmission } from './connection-admission';
import { runAlchemist, runBowyer } from './crafter';
import { residentCredentials } from './credentials';
import type { DecisionConfig } from './decision-provider';
import { DecisionCoordinator } from './decisions';
import { runFighter } from './fighter';
import { runFisher } from './fisher';
import { watchForGuards } from './guards';
import { runLumberjack } from './lumberjack';
import { runMiner } from './miner';
import { RuntimeOwnership } from './ownership';
import { PathPool } from './path-pool';
import { Layer } from './protocol/layers';
import { createCharacter } from './protocol/packets';
import { type CharacterRequest, PlayerSession } from './protocol/session';
import { shardProfile } from './shard-profile';
import { recordSkills } from './skill-snapshots';
import { skillId } from './skills';
import { maintainLocks } from './stat-locks';
import { type Resident, ResidentStore } from './store';
import { runTailor } from './tailor';
import { runTamer } from './tamer';
import { personalTemplate } from './temperament';
import { runThief } from './thief';

function creationRequest(store: ResidentStore, resident: Resident, enabled: boolean): CharacterRequest {
  if (!enabled || resident.binding) return { slot: 0 };
  const template = store.template(resident.templateId, resident.creationVersion);
  if (!template) throw new Error('Resident creation template is missing');
  if (template.creation.equipment.length)
    throw new Error('Custom starting equipment cannot be provisioned through this ordinary creation profile');
  const name = resident.proposedName;
  const skills = Object.entries(template.creation.skills).map(([skill, value]) => {
    const id = skillId(skill);
    return { id, value };
  });
  const create = {
    name,
    city: template.creation.city,
    skills,
    appearance: appearanceOf(resident.id, shardProfile().races)
  };
  createCharacter({ ...create, city: 0, slot: 0 });
  return { slot: 0, create };
}

async function exercise(session: PlayerSession) {
  const before = { ...session.world.position };
  let walked = false;
  const heading = session.world.position?.direction ?? 0;
  for (let attempt = 0; attempt < 4 && !walked; attempt++) {
    const direction = (heading + attempt * 2) % 8;
    await session.walk(direction);
    await Bun.sleep(500);
    const p = session.world.position;
    if (p && (p.x !== before.x || p.y !== before.y)) walked = true;
    if (!walked && p?.direction === direction) {
      await session.walk(direction);
      await Bun.sleep(500);
      const next = session.world.position;
      walked = !!next && (next.x !== before.x || next.y !== before.y);
    }
  }
  if (!walked) throw new Error('Server did not acknowledge a change in position');
  const line = 'Hello, Britannia.';
  session.say(line);
  await session.waitFor(
    () => session.world.journal.some((entry) => entry.serial === session.world.serial && entry.text === line),
    'server speech echo'
  );
  const backpack = [...session.world.entities.values()].find(
    (entity) => entity.parent === session.world.serial && entity.layer === Layer.Backpack
  );
  if (!backpack) throw new Error('No observed backpack');
  const contentsBefore = session.world.received.get(0x3c) ?? 0;
  session.use(backpack.serial);
  await session.waitFor(() => (session.world.received.get(0x3c) ?? 0) > contentsBefore, 'backpack contents');
  const tool = [...session.world.entities.values()].find(
    (entity) => entity.parent === backpack.serial && [0x0e85, 0x0e86, 0x0f39, 0x0f3a].includes(entity.graphic)
  );
  if (!tool) throw new Error('This exercise needs a normal starting pickaxe or shovel (use a miner template)');
  session.use(tool.serial);
  await session.waitFor(() => session.world.target !== null, 'tool targeting cursor');
  const cursor = session.world.target?.id;
  const feedbackBefore = session.world.journal.length;
  const position = session.world.position;
  if (!position || session.world.serial === null) throw new Error('Character state disappeared');
  session.target({
    serial: session.world.serial,
    ...position,
    graphic: session.world.entities.get(session.world.serial)?.graphic ?? 0
  });
  await session.waitFor(() => session.world.journal.length > feedbackBefore, 'tool targeting feedback');
  return {
    walked: true,
    before,
    after: { ...session.world.position },
    speechEchoed: true,
    backpackObserved: true,
    targetingCursor: cursor,
    targetFeedback: session.world.journal.slice(feedbackBefore)
  };
}

export interface ResidentOptions {
  population: PopulationConfig;
  connection: ConnectionConfig;
  dbPath: string;
  create: boolean;
  exercise: boolean;
  reconnect: boolean;
  reconnectAttempts: number;
  durationSeconds: number;
  minerAssets?: string;
  fighterAssets?: string;
  lumberjackAssets?: string;
  // Newer professions (fisher, tailor, bard, tamer, thief) run through one profession runtime.
  profession?: {
    behavior: 'fisher' | 'tailor' | 'alchemist' | 'bowyer' | 'bard' | 'tamer' | 'thief';
    assets: string;
  };
  decisionConfig?: DecisionConfig;
  // Walk to distant cemeteries instead of taking a moongate (load tests); off by default.
  overland?: boolean;
}

// Shared by every resident a runtime drives: one store, one shard lease, one stop signal.
export interface RuntimeShared {
  store: ResidentStore;
  signal: AbortSignal;
  ownership: RuntimeOwnership;
  stopping: () => boolean;
  // The resident's current session, so a shutdown or lost lease can close it.
  track: (residentId: string, session: PlayerSession | null) => void;
}

export async function runResident(shared: RuntimeShared, options: ResidentOptions, residentId: string) {
  const { store, ownership, stopping } = shared;
  const runtime: { session: PlayerSession | null } = { session: null };
  try {
    const selected = store.get(residentId);
    if (!selected?.desiredActive) throw new Error('No desired active resident matches this session');
    let resident: Resident = selected;
    const credentialRef = `resident:${resident.id}`;
    if (resident.binding && resident.binding.accountRef !== credentialRef)
      throw new Error('Unsupported resident account reference');
    const dataDirectory = dirname(options.dbPath);
    const credentials = await residentCredentials(
      store,
      resident.id,
      options.create && !resident.binding,
      join(dataDirectory, 'credentials')
    );
    const decisions = options.decisionConfig
      ? new DecisionCoordinator(options.decisionConfig, (checkpoint) => {
          resident = store.saveProgress(resident.id, resident.revision, checkpoint, resident.binding);
        })
      : undefined;
    const connect = () =>
      connectionAdmission.run(async () => {
        ownership.assert();
        runtime.session?.close();
        const session = new PlayerSession(options.connection, () => ownership.assert());
        runtime.session = session;
        shared.track(residentId, session);
        await session.connect(credentials, creationRequest(store, resident, options.create));
        const serial = session.world.serial;
        if (serial === null) throw new Error('Server did not identify the character');
        if (resident.binding && resident.binding.characterSerial !== String(serial))
          throw new Error('Bound character changed; refusing to control a replacement');
        resident = store.saveProgress(resident.id, resident.revision, resident.checkpoint, {
          accountRef: credentialRef,
          characterSerial: String(serial)
        });
        recordSkills(store, resident.id, session);
        // Bolder residents are the ones who shout for the guards (guards.ts).
        const boldness =
          0.3 + 0.6 * (store.template(resident.templateId, resident.policyVersion)?.behavior.riskTolerance ?? 0.5);
        watchForGuards(session, boldness, (line) => console.error(`[guards:${resident.proposedName}] ${line}`));
        return session;
      }, shared.signal);
    let active: PlayerSession | undefined;
    for (let attempt = 0; !active; attempt++) {
      try {
        active = await connect();
      } catch (error) {
        if (stopping() || attempt >= options.reconnectAttempts || !runtime.session?.reconnectable) throw error;
        runtime.session.close();
        console.error(
          `[session:${resident.proposedName}] Initial connection retry ${attempt + 1}: ${runtime.session.failureReason}`
        );
        await Bun.sleep(Math.min(500 * 2 ** attempt, 5000));
      }
    }
    await Bun.sleep(500);
    const actions = options.exercise ? await exercise(active) : null;
    const template = store.template(resident.templateId, resident.policyVersion);
    if (!template) throw new Error('Resident policy template is missing');
    let mining: Awaited<ReturnType<typeof runMiner>> | null = null;
    let hunting: Awaited<ReturnType<typeof runFighter>> | null = null;
    let lumber: Awaited<ReturnType<typeof runLumberjack>> | null = null;
    let profession: { behavior: string; stopped: string; progress: Record<string, number> } | null = null;
    let behaviorRecoveryAttempts = 0;
    let behaviorRuns = 0;
    if (options.minerAssets || options.fighterAssets || options.lumberjackAssets || options.profession) {
      const totals: Record<string, number> = {};
      const behave = async (session: PlayerSession, seconds: number) => {
        const peers = new Map(
          store
            .bindings()
            .filter((other) => other.id !== resident.id)
            .map((other) => [other.serial, other.name] as const)
        );
        const common = {
          label: resident.proposedName,
          overland: options.overland,
          peers,
          session,
          template: personalTemplate(template, resident.id),
          decisions,
          seconds,
          checkpoint: resident.checkpoint,
          stopping,
          save: (checkpoint: Resident['checkpoint']) => {
            resident = store.saveProgress(resident.id, resident.revision, checkpoint, resident.binding);
          }
        };
        if (options.minerAssets) {
          const result = await runMiner({ ...common, assets: options.minerAssets });
          for (const [key, value] of Object.entries(result))
            if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
          mining = { ...result, ...totals };
          return result.stopped;
        }
        if (options.profession) {
          const run = {
            fisher: runFisher,
            tailor: runTailor,
            alchemist: runAlchemist,
            bowyer: runBowyer,
            bard: runBard,
            tamer: runTamer,
            thief: runThief
          }[options.profession.behavior];
          const result = await run({
            ...common,
            assets: options.profession.assets,
            recordRun: (record) =>
              store.recordDungeonRun({
                ...record,
                id: crypto.randomUUID(),
                residentId: resident.id,
                name: resident.proposedName
              })
          });
          for (const [key, value] of Object.entries(result.progress)) totals[key] = (totals[key] ?? 0) + value;
          profession = { behavior: options.profession.behavior, stopped: result.stopped, progress: { ...totals } };
          return result.stopped;
        }
        if (options.lumberjackAssets) {
          const result = await runLumberjack({ ...common, assets: options.lumberjackAssets });
          for (const [key, value] of Object.entries(result))
            if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
          lumber = { ...result, ...totals };
          return result.stopped;
        }
        if (!options.fighterAssets) throw new Error('Missing fighter assets');
        const result = await runFighter({
          ...common,
          assets: options.fighterAssets,
          recordRun: (record) =>
            store.recordDungeonRun({
              ...record,
              id: crypto.randomUUID(),
              residentId: resident.id,
              name: resident.proposedName
            })
        });
        for (const [key, value] of Object.entries(result))
          if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
        hunting = { ...result, ...totals };
        return result.outcome;
      };
      const supervised = await superviseBehavior({
        session: active,
        deadline: Date.now() + options.durationSeconds * 1000,
        maxReconnects: options.reconnectAttempts,
        stopping,
        assertOwnership: () => ownership.assert(),
        connect,
        latestSession: () => runtime.session,
        run: async (session, seconds) => {
          // Every character steers its stat and skill locks toward its build for the whole run.
          const releaseLocks = template.archetype
            ? maintainLocks(session, template.archetype, Object.keys(template.behavior.trainingGoals))
            : () => {};
          try {
            return await behave(session, seconds);
          } finally {
            releaseLocks();
          }
        }
      });
      active = supervised.session;
      behaviorRecoveryAttempts = supervised.recoveryAttempts;
      behaviorRuns = supervised.runs;
    }
    if (options.reconnect) {
      const serial = active.world.serial;
      active.close();
      await Bun.sleep(1500);
      active = await connect();
      if (active.world.serial !== serial) throw new Error('Reconnect selected a different character');
    }
    const endAt =
      Date.now() +
      (options.minerAssets || options.fighterAssets || options.lumberjackAssets ? 0 : options.durationSeconds * 1000);
    let recoveryAttempts = behaviorRecoveryAttempts;
    while (Date.now() < endAt && !stopping()) {
      ownership.assert();
      if (active.phase !== 'ready') {
        if (!active.reconnectable) throw new Error('Session failed with a non-retryable protocol or character error');
        active.close();
        while (!stopping()) {
          if (recoveryAttempts >= options.reconnectAttempts) throw new Error('Session reconnect budget exhausted');
          await Bun.sleep(Math.min(500 * 2 ** recoveryAttempts, 5000));
          if (stopping()) break;
          recoveryAttempts++;
          try {
            active = await connect();
            break;
          } catch (error) {
            if (!runtime.session?.reconnectable) throw error;
          }
        }
      }
      await Bun.sleep(Math.max(0, Math.min(250, endAt - Date.now())));
    }
    if (
      !stopping() &&
      active.phase !== 'ready' &&
      !options.minerAssets &&
      !options.fighterAssets &&
      !options.lumberjackAssets
    )
      throw new Error('Session ended before the observation interval completed');
    const result = {
      residentId: resident.id,
      profile: options.connection.profile,
      actions,
      mining,
      hunting,
      lumber,
      profession,
      mount: resident.checkpoint.mount ?? null,
      decisions: resident.checkpoint.decisions ?? null,
      decisionConfiguration: options.decisionConfig ?? null,
      reconnected: options.reconnect || recoveryAttempts > 0,
      behaviorRuns,
      recoveryAttempts,
      stoppedBySignal: stopping(),
      sessionPhase: active.phase,
      movement: active.movementCounts,
      latency: active.timing.snapshot(),
      observed: active.world.snapshot()
    };
    const proofDirectory = join(dataDirectory, 'proofs');
    await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(proofDirectory, `${resident.id}-latest.json`), JSON.stringify(result, null, 2), {
      mode: 0o600
    });
    return result;
  } finally {
    runtime.session?.close();
    shared.track(residentId, null);
  }
}

// Opens the store, takes the single shard lease, and closes every tracked session on SIGINT,
// SIGTERM, or a lost lease. One runtime process may drive one or many residents.
export async function withRuntime<T>(
  options: Pick<ResidentOptions, 'population' | 'connection' | 'dbPath'>,
  body: (shared: RuntimeShared) => Promise<T>
): Promise<T | { stoppedBySignal: true }> {
  if (options.population.shardId !== options.connection.shardId)
    throw new Error('Connection and population belong to different shards');
  const store = new ResidentStore(options.dbPath, options.population.shardId);
  const sessions = new Map<string, PlayerSession>();
  let ownership: RuntimeOwnership | null = null;
  let stopping = false;
  const controller = new AbortController();
  const closeAll = () => {
    for (const session of sessions.values()) session.close();
  };
  const stop = () => {
    stopping = true;
    controller.abort();
    closeAll();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    ownership = new RuntimeOwnership(store, stop);
    store.reconcile(options.population);
    return await body({
      store,
      signal: controller.signal,
      ownership,
      stopping: () => stopping,
      track: (id, session) => {
        if (session) sessions.set(id, session);
        else sessions.delete(id);
      }
    });
  } catch (error) {
    if (stopping) return { stoppedBySignal: true };
    throw error;
  } finally {
    closeAll();
    PathPool.closeAll();
    ownership?.close();
    store.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export async function runSession(options: ResidentOptions & { residentId?: string }) {
  return withRuntime(options, async (shared) => {
    const selected = options.residentId
      ? shared.store.list().find((r) => r.id === options.residentId)
      : shared.store.list().find((r) => r.desiredActive);
    if (!selected?.desiredActive) throw new Error('No desired active resident matches this session');
    return runResident(shared, options, selected.id);
  });
}
