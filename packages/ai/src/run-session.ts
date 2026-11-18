import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { skillId, skillNames } from '@gemwright/common/game/skills';
import type { ConnectionConfig } from '@gemwright/network/connection';
import { Layer } from '@gemwright/network/layers';
import { Opcode } from '@gemwright/network/opcodes';
import { PlayerSession } from '@gemwright/network/session';

import { supportingOf } from './archetypes';
import { superviseBehavior } from './behavior-supervisor';
import type { PopulationConfig } from './config';
import { connectionAdmission } from './connection-admission';
import { creationRequest } from './creation-request';
import { residentCredentials } from './credentials';
import { historyAt } from './history';
import { logger } from './log';
import type { RuntimeOwnership } from './ownership';
import { recordSession } from './recording';
import { withRuntime } from './runtime';
import { registerDurability } from './session-durability';
import { act } from './shadow';
import { recordSkills } from './skill-snapshots';
import type { Resident, ResidentStore } from './store';
import { emitEvent, inSession, makeEvent } from './telemetry';
import { miningTools } from './vendor-catalog';

export { withRuntime };

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
  const feedbackBefore = session.world.heard;
  const position = session.world.position;
  if (!position || session.world.serial === null) throw new Error('Character state disappeared');
  session.target({
    serial: session.world.serial,
    ...position,
    graphic: session.world.entities.get(session.world.serial)?.graphic ?? 0
  });
  await session.waitFor(() => session.world.heard > feedbackBefore, 'tool targeting feedback');
  return {
    walked: true,
    before,
    after: { ...session.world.position },
    speechEchoed: true,
    backpackObserved: true,
    targetingCursor: cursor,
    targetFeedback: session.world.journalSince(feedbackBefore)
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
  // The mind lives the resident for the whole duration.
  live?: boolean;
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
    const flush = () => store.flush();
    const connect = () =>
      connectionAdmission.run(async () => {
        await flush();
        ownership.assert();
        runtime.session?.close();
        const session = new PlayerSession(options.connection, () => ownership.assert());
        recordSession(session, residentId);
        registerDurability(session, flush);
        runtime.session = session;
        shared.track(residentId, session);
        return inSession(session, async () => {
          await session.connect(credentials, creationRequest(store, resident, options.create));
          const serial = session.world.serial;
          if (serial === null) throw new Error('Server did not identify the character');
          if (resident.binding && resident.binding.characterSerial !== String(serial))
            throw new Error('Bound character changed; refusing to control a replacement');
          resident = store.bind(resident.id, resident.revision, {
            accountRef: credentialRef,
            characterSerial: String(serial)
          });
          await store.flush();
          recordSkills(store, resident.id, session);
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
    let behaviorRecoveryAttempts = 0;
    let behaviorRuns = 0;
    if (options.live) {
      const history = historyAt(join(dataDirectory, 'history.sqlite'));
      const trade = (template.archetype?.primarySkills ?? []).map((skill) => skillNames[skillId(skill)] ?? skill);
      const supporting = (supportingOf(template.archetype) ?? []).map((skill) => skillNames[skillId(skill)] ?? skill);
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
        run: async (session, seconds) =>
          inSession(session, async () => {
            const until = Date.now() + seconds * 1000;
            await act(session, resident.id, history, () => stopping() || Date.now() > until, trade, supporting);
            return 'stopped';
          })
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
    const endAt = Date.now() + (options.live ? 0 : options.durationSeconds * 1000);
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
    if (!stopping() && active.phase !== 'ready' && !options.live)
      throw new Error('Session ended before the observation interval completed');
    const result = {
      residentId: resident.id,
      profile: options.connection.profile,
      actions,
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

export async function runSession(options: ResidentOptions & { residentId?: string }) {
  return withRuntime(options, async (shared) => {
    const selected = options.residentId
      ? shared.store.list().find((r) => r.id === options.residentId)
      : shared.store.list().find((r) => r.desiredActive);
    if (!selected?.desiredActive) throw new Error('No desired active resident matches this session');
    return runResident(shared, options, selected.id);
  });
}
