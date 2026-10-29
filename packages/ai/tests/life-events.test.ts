import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { observeLifeActions } from '../src/life-actions';
import { type LifeEvent, lifeEvent, recordLifeAction, registerLifeEvents } from '../src/life-events';
import { openLifeJournal } from '../src/life-journal';
import { behaviorFixture, required } from './behavior-fixture';

function fixture() {
  const f = behaviorFixture();
  const events: LifeEvent[] = [];
  f.session.close = () => {};
  f.session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('condition not confirmed');
  };
  registerLifeEvents(f.session, 'resident-1', 'Test Resident', (event) => events.push(structuredClone(event)));
  return { ...f, events };
}

test('item transfers record paired attempts, actual outcomes, names and positions', async () => {
  const f = fixture();
  f.world.entities.set(42, { serial: 42, kind: 'item', graphic: 0xe21, name: 'bandages', parent: 10, amount: 5 });
  f.session.moveItem = async (serial, parent) => {
    required(f.world.entities.get(serial)).parent = parent;
  };
  observeLifeActions(f.session);
  await f.session.moveItem(42, 20, 5);
  const events = f.events.filter((event) => event.type === 'moveItem');
  expect(events.map((event) => event.result)).toEqual(['started', 'completed']);
  expect(events[0]?.actionId).toBe(events[1]?.actionId);
  expect(events[0]?.details.item).toMatchObject({ name: 'bandages', parent: 10, amount: 5 });
  expect(events[1]?.details.subjectAfter).toMatchObject({ parent: 20 });
  expect(events[0]?.position).toMatchObject({ map: 1, x: 100, y: 100 });
});

test('a refused purchase is recorded as failed and still throws to the runner', async () => {
  const f = fixture();
  f.session.purchaseItem = async () => {
    throw new Error('Vendor refused the purchase');
  };
  observeLifeActions(f.session);
  let caught: unknown;
  try {
    await f.session.purchaseItem(2, 3, 10, 4, 200);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const failed = required(f.events.find((event) => event.type === 'purchaseItem' && event.result === 'failed'));
  expect(failed.details).toMatchObject({ amount: 4, budget: 200, reason: 'Vendor refused the purchase' });
  expect(f.events.some((event) => event.type === 'purchaseItem' && event.result === 'completed')).toBe(false);
});

test('sending a skill request is distinct from an observed skill gain', () => {
  const f = fixture();
  f.session.useSkill = () => {};
  f.world.skills.set(7, { base: 50, value: 50, cap: 100, lock: 0 });
  observeLifeActions(f.session);
  f.session.useSkill(7);
  expect(f.events.filter((event) => event.type === 'useSkill').map((event) => event.result)).toEqual([
    'started',
    'sent'
  ]);
  const packet = Buffer.alloc(13);
  packet[0] = 0x3a;
  packet.writeUInt16BE(13, 1);
  packet[3] = 0xdf;
  packet.writeUInt16BE(7, 4);
  packet.writeUInt16BE(501, 6);
  packet.writeUInt16BE(501, 8);
  packet.writeUInt16BE(1000, 11);
  f.world.apply(packet);
  expect(f.events.find((event) => event.type === 'skill_changed')?.details).toMatchObject({
    skill: 'Blacksmith',
    before: 50,
    after: 50.1
  });
});

test('death preserves recent attackers without inventing a killer or a resurrection', () => {
  const f = fixture();
  f.world.entities.set(42, {
    serial: 42,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    position: { x: 101, y: 100, z: 0, direction: 0 }
  });
  f.world.swings.set(42, { target: 1, at: Date.now() });
  observeLifeActions(f.session);
  f.world.apply(Buffer.from([0x2c, 0]));
  f.world.apply(Buffer.from([0x72, 0, 0, 0, 0]));
  const death = required(f.events.find((event) => event.type === 'death'));
  expect(death.details.killer).toBeNull();
  expect(death.details.recentAttackers).toMatchObject([{ name: 'a zombie', graphic: 3 }]);
  expect(f.events.filter((event) => event.type === 'death')).toHaveLength(1);
  expect(f.events.some((event) => event.type === 'resurrection')).toBe(false);
});

test('nested travel and action records retain their parent and action IDs', async () => {
  const f = fixture();
  await recordLifeAction(f.session, 'travel', { from: { x: 100, y: 100 }, to: { x: 200, y: 200 } }, async () => {
    await recordLifeAction(f.session, 'door', { serial: 42 }, async () => {});
    f.world.position = { x: 200, y: 200, z: 0, direction: 0 };
  });
  const travel = required(f.events.find((event) => event.type === 'travel' && event.result === 'started'));
  expect(f.events.find((event) => event.type === 'door')?.parentId).toBe(travel.actionId);
  const arrived = f.events.find((event) => event.type === 'travel' && event.result === 'completed');
  expect(arrived?.actionId).toBe(travel.actionId);
  expect(arrived?.position).toMatchObject({ x: 200, y: 200 });
  expect(f.checkpoint.memories).toEqual([]);
});

test('daily event files append across restarts and close only after acknowledged durability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-life-events-'));
  const errors: Error[] = [];
  try {
    const f = fixture();
    for (let run = 0; run < 2; run++) {
      const journal = await openLifeJournal(directory, (error) => errors.push(error));
      registerLifeEvents(f.session, 'resident-1', 'Test Resident', journal.append);
      lifeEvent(f.session, 'work_result', 'observed', { counter: 'crafted', amount: run + 1 });
      await journal.close();
    }
    const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl.gz`);
    const lines = gunzipSync(await readFile(file))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as LifeEvent);
    expect(lines).toHaveLength(4);
    expect(lines.filter((event) => event.type === 'work_result').map((event) => event.details.amount)).toEqual([1, 2]);
    expect(new Set(lines.map((event) => event.id)).size).toBe(4);
    expect(new Set(lines.map((event) => event.sessionId)).size).toBe(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(errors).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('journal write failures are surfaced rather than silently dropping the history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-life-failure-'));
  const errors: Error[] = [];
  const journal = await openLifeJournal(directory, (error) => errors.push(error));
  try {
    await mkdir(join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl.gz`));
    const f = fixture();
    registerLifeEvents(f.session, 'resident-1', 'Test Resident', journal.append);
    const failure = await journal.flush().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(errors).toHaveLength(1);
  } finally {
    await journal.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('life recording subscribes to decoded observations without replacing the world decoder', () => {
  const f = fixture();
  const original = f.world.apply;
  observeLifeActions(f.session);
  expect(f.world.apply).toBe(original);
  const death = Buffer.alloc(13);
  death[0] = 0xaf;
  death.writeUInt32BE(42, 1);
  death.writeUInt32BE(99, 5);
  f.world.apply(death);
  expect(f.events.find((event) => event.type === 'death_witnessed')?.details).toMatchObject({
    corpse: 99,
    creditedKill: false
  });
});
