import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectionConfig } from '@gemwright/network/connection';
import { Layer } from '@gemwright/network/layers';
import { PlayerSession } from '@gemwright/network/session';

import { logger } from './log';
import { recordDecision, recordSession } from './recording';
import { emitEvent, inSession, makeEvent } from './telemetry';
import { SESSION_BREAK } from './v1/action-errors';
import { runBard } from './v1/bard';
import { superviseBehavior } from './v1/behavior-supervisor';
import { registerChaos } from './v1/chaos';
import type { PopulationConfig } from './v1/config';
import { connectionAdmission } from './v1/connection-admission';
import { runAlchemist, runBowyer } from './v1/crafter';
import { creationRequest } from './v1/creation-request';
import { residentCredentials } from './v1/credentials';
import { type DecisionConfig, inModelShare } from './v1/decision-provider';
import { DecisionCoordinator } from './v1/decisions';
import { runFighter } from './v1/fighter';
import { runFisher } from './v1/fisher';
import { registerCheckpoint } from './v1/gm';
import { watchForGuards } from './v1/guards';
import { LIFE_GOAL } from './v1/life-goal';
import { runLumberjack } from './v1/lumberjack';
import { runMiner } from './v1/miner';
import type { RuntimeOwnership } from './v1/ownership';
import { enableSessionHabits } from './v1/resident-context';
import { withRuntime } from './v1/runtime';
import { registerDurability } from './v1/session-durability';
import { SessionBreak } from './v1/session-habits';
import { recordSkills } from './v1/skill-snapshots';
import { maintainLocks } from './v1/stat-locks';
import type { Resident, ResidentStore } from './v1/store';

export { withRuntime } from './v1/runtime';

import { skillId, skillNames } from '@gemwright/common/game/skills';
import { Opcode } from '@gemwright/network/opcodes';

import { runTailor } from './v1/tailor';
import { runTamer } from './v1/tamer';
import { personalTemplate } from './v1/temperament';
import { runThief } from './v1/thief';
import { guardTrades } from './v1/trade-guard';
import { miningTools } from './v1/vendor-catalog';
import { historyAt } from './v2/history';
import { act, shadow } from './v2/shadow';

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
  const contentsBefore = session.world.received.get(Opcode.containerContents) ?? 0;
  session.use(backpack.serial);
  await session.waitFor(
    () => (session.world.received.get(Opcode.containerContents) ?? 0) > contentsBefore,
    'backpack contents'
  );
  const tool = [...session.world.entities.values()].find(
    (entity) => entity.parent === backpack.serial && miningTools.has(entity.graphic)
  );
  if (!tool) throw new Error('This exercise needs a normal starting pickaxe or shovel (use a miner template)');
  session.use(tool.serial);
  await session.waitFor(() => session.world.target !== null, 'tool targeting cursor', undefined, {
    resource: 'target'
  });
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
  naturalSessions?: boolean;
  // The v2 mind watches beside v1 (online.json `mind: "shadow"`): it perceives and records, never acts.
  shadow?: boolean;
  // The v2 mind lives it instead of v1 (online.json `mind: "v2"`).
  v2?: boolean;
}

// Shared by every resident a runtime drives: one store, one shard lease, one stop signal.
export interface RuntimeShared {
  store: ResidentStore;
  signal: AbortSignal;
  ownership: RuntimeOwnership;
  stopping: () => boolean;
  // The resident's current session, so a shutdown or lost lease can close it. v1's command arbiter
  // (its danger interrupts) is left out of a session the v2 mind lives.
  track: (residentId: string, session: PlayerSession | null, v2?: boolean) => void;
}

export async function runResident(shared: RuntimeShared, options: ResidentOptions, residentId: string) {
  const { store, ownership, stopping } = shared;
  const runtime: { session: PlayerSession | null } = { session: null };
  // The last coalesced save, written however the run ends.
  let writeLast = () => {};
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
    // Residents outside the model's share decide locally: the baseline it is compared against.
    const config =
      options.decisionConfig &&
      options.decisionConfig.providers[0]?.provider !== 'local' &&
      !inModelShare(resident.id, options.decisionConfig.share)
        ? { ...options.decisionConfig, providers: [{ provider: 'local' as const }] }
        : options.decisionConfig;
    // A resident's ordinary saves are coalesced to one write every few seconds: each one stringifies
    // the whole checkpoint on the main thread, and at a save every second or two across the
    // population the event loop fell behind enough to make every walk stutter. The worker commits
    // in five-second batches anyway; a flush (critical actions, reconnects, the end) writes at once.
    let pending: Resident['checkpoint'] | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const writePending = () => {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      if (!pending) return;
      const checkpoint = pending;
      pending = undefined;
      resident = store.saveProgress(resident.id, resident.revision, checkpoint, resident.binding);
    };
    const save = (checkpoint: Resident['checkpoint']) => {
      pending = checkpoint;
      pendingTimer ??= setTimeout(writePending, 5000);
    };
    writeLast = writePending;
    const flush = async () => {
      writePending();
      await store.flush();
    };
    const decisionLog = store.decisionLog();
    const decisions = config
      ? new DecisionCoordinator(config, save, undefined, store.spendLedger(), (trace, request, exchanges, flow) => {
          decisionLog.record(resident.id, trace, request, exchanges, flow);
          recordDecision(resident.id, { trace, request, exchanges });
        })
      : undefined;
    const connect = () =>
      connectionAdmission.run(async () => {
        await flush();
        ownership.assert();
        runtime.session?.close();
        const session = new PlayerSession(options.connection, () => ownership.assert());
        recordSession(session, residentId);
        registerDurability(session, flush);
        runtime.session = session;
        shared.track(residentId, session, options.v2);
        return inSession(session, async () => {
          await session.connect(credentials, creationRequest(store, resident, options.create));
          // v1's own habits and reflexes (trade guard, session habits with their danger interrupts,
          // chaos, shouting for guards) are left out of a resident the v2 mind lives.
          if (!options.v2) {
            guardTrades(session);
            if (options.naturalSessions) enableSessionHabits(session);
            const policy = store.template(resident.templateId, resident.policyVersion);
            if (policy) registerChaos(session, policy);
          }
          const serial = session.world.serial;
          if (serial === null) throw new Error('Server did not identify the character');
          if (resident.binding && resident.binding.characterSerial !== String(serial))
            throw new Error('Bound character changed; refusing to control a replacement');
          resident = store.saveProgress(resident.id, resident.revision, resident.checkpoint, {
            accountRef: credentialRef,
            characterSerial: String(serial)
          });
          await store.flush();
          recordSkills(store, resident.id, session);
          // Bolder residents are the ones who shout for the guards (guards.ts).
          const boldness =
            0.3 + 0.6 * (store.template(resident.templateId, resident.policyVersion)?.behavior.riskTolerance ?? 0.5);
          if (!options.v2)
            watchForGuards(session, boldness, (line) =>
              logger('run-session').info(`[guards:${resident.proposedName}] ${line}`)
            );
          return session;
        });
      }, shared.signal);
    let active: PlayerSession | undefined;
    for (let attempt = 0; !active; attempt++) {
      try {
        active = await connect();
      } catch (error) {
        if (stopping() || attempt >= options.reconnectAttempts || !runtime.session?.reconnectable) throw error;
        runtime.session.close();
        logger('run-session').info(
          `[session:${resident.proposedName}] Initial connection retry ${attempt + 1}: ${runtime.session.failureReason}`
        );
        await Bun.sleep(Math.min(500 * 2 ** attempt, 5000));
      }
    }
    await Bun.sleep(500);
    const actions = options.exercise ? await exercise(active) : null;
    const template = store.template(resident.templateId, resident.policyVersion);
    if (!template) throw new Error('Resident policy template is missing');
    logger('run-session').info(`[life-goal:${resident.proposedName}] ${LIFE_GOAL}`);
    let mining: Awaited<ReturnType<typeof runMiner>> | null = null;
    let hunting: Awaited<ReturnType<typeof runFighter>> | null = null;
    let lumber: Awaited<ReturnType<typeof runLumberjack>> | null = null;
    let profession: { behavior: string; stopped: string; progress: Record<string, number> } | null = null;
    let sessionBreak = false;
    let behaviorRecoveryAttempts = 0;
    let behaviorRuns = 0;
    if (options.minerAssets || options.fighterAssets || options.lumberjackAssets || options.profession) {
      const totals: Record<string, number> = {};
      const behave = async (session: PlayerSession, seconds: number) => {
        if (options.naturalSessions && !options.v2) enableSessionHabits(session);
        registerCheckpoint(session, resident.checkpoint);
        const peers = new Map(
          store
            .bindings()
            .filter((other) => other.id !== resident.id)
            .map((other) => [other.serial, other.name] as const)
        );
        const common = {
          label: resident.proposedName,
          peers,
          session,
          template: personalTemplate(template, resident.id),
          decisions,
          seconds,
          checkpoint: resident.checkpoint,
          stopping,
          save
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
        onRecovery: (session, attempt, reason) =>
          inSession(session, () =>
            emitEvent(
              makeEvent('session', 'behavior_recovery', 'started', {
                attempt,
                reason,
                phase: session.phase,
                maxReconnects: options.reconnectAttempts
              }),
              { stdout: true }
            )
          ),
        // A deliberate break ends the session: it is not a returned behavior to run again.
        shouldRepeat: (result: unknown) => result !== SESSION_BREAK,
        run: async (session, seconds) =>
          inSession(session, async () => {
            // Every character steers its stat and skill locks toward its build for the whole run.
            if (options.v2) {
              const until = Date.now() + seconds * 1000;
              await act(
                session,
                resident.id,
                historyAt(join(dataDirectory, 'history.sqlite')),
                () => stopping() || Date.now() > until,
                (template.archetype?.primarySkills ?? []).map((skill) => skillNames[skillId(skill)] ?? skill)
              );
              return 'stopped';
            }
            const releaseLocks = template.archetype
              ? maintainLocks(session, template.archetype, Object.keys(template.behavior.trainingGoals))
              : () => {};
            const stopShadow = options.shadow
              ? shadow(session, resident.id, historyAt(join(dataDirectory, 'history.sqlite')))
              : () => {};
            try {
              return await behave(session, seconds);
            } catch (error) {
              if (error instanceof SessionBreak) return SESSION_BREAK;
              throw error;
            } finally {
              stopShadow();
              releaseLocks();
            }
          })
      });
      active = supervised.session;
      behaviorRecoveryAttempts = supervised.recoveryAttempts;
      behaviorRuns = supervised.runs;
      // A break ends the session cleanly: the population honours the habit's offline window before
      // the resident comes back, instead of restarting it into the same evening.
      if (supervised.result === SESSION_BREAK) sessionBreak = true;
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
      (options.minerAssets || options.fighterAssets || options.lumberjackAssets || options.profession
        ? 0
        : options.durationSeconds * 1000);
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
      !options.lumberjackAssets &&
      !options.profession
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
      // A deliberate break (session-habits.ts): the population honours the offline window instead of
      // treating this as a finished session to restart.
      sessionBreak,
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
    writeLast();
    runtime.session?.close();
    shared.track(residentId, null);
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
