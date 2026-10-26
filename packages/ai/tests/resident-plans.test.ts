import { expect, test } from 'bun:test';

import { tally } from '../src/activity';
import { orderConversation } from '../src/order-conversation';
import { goalPhaseBias, updatePersonalGoals } from '../src/personal-goals';
import { personalMemory, sharedMemoryLine } from '../src/resident-memory';
import { sessionHabits } from '../src/session-habits';
import { learnedPlaceCost, learnWork } from '../src/strategy-learning';
import { acceptWorkOrder, finishWorkOrder, orderDemand, orderQuote, orderTurn, reservedFor } from '../src/work-orders';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function supplier() {
  const f = socialFixture('lumberjack');
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    name: 'Ada',
    position: { x: 101, y: 100, z: 0, direction: 0 }
  });
  f.world.entities.set(19, { serial: 19, kind: 'item', graphic: 0xf43, parent: 10 });
  f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x1bd7, amount: 30, parent: 10 });
  return f;
}

test('an order reserves actual stock without claiming delivery or earned trust', () => {
  const f = supplier();
  expect(acceptWorkOrder(f.session, 2, 'Ada', { good: 'boards', amount: 20, price: 100 })).toContain('agreed');
  expect(orderDemand(f.session, 'boards')).toBe(20);
  expect(reservedFor(f.session, required(f.world.entities.get(20)))).toBe(20);
  expect(orderQuote(f.session, 2)?.price).toBe(100);
  expect(f.checkpoint.personal?.partners['2']?.trust).toBe(0);
  expect(sharedMemoryLine(f.checkpoint, 2)).toBeUndefined();
  expect(f.checkpoint.personal?.orders[0]?.state).toBe('ready');
});

test('quoted and counterquoted orders require customer agreement and can be cancelled', () => {
  const f = supplier();
  expect(orderConversation(f.session, 2, 'Ada', 'make 20 boards')).toContain('Shall I take');
  expect(f.checkpoint.personal?.orders).toHaveLength(0);
  expect(orderConversation(f.session, 2, 'Ada', 'deal')).toContain('agreed');
  expect(orderConversation(f.session, 2, 'Ada', 'cancel my order')).toContain('cancelled');
  expect(orderDemand(f.session, 'boards')).toBe(0);
  expect(orderConversation(f.session, 2, 'Ada', 'supply 20 boards for 1 gold')).toContain('Shall I take');
  expect(orderConversation(f.session, 2, 'Ada', 'yes')).toContain('agreed');
  expect(f.checkpoint.personal?.orders.at(-1)?.price).toBeGreaterThan(1);
});

test('unrelated people cannot confirm a pending quote, and unsupported work is refused honestly', () => {
  const f = supplier();
  orderConversation(f.session, 2, 'Ada', 'make 20 boards');
  expect(orderConversation(f.session, 3, 'Ben', 'yes')).toBeUndefined();
  expect(f.checkpoint.personal?.orders).toHaveLength(0);
  expect(acceptWorkOrder(f.session, 2, 'Ada', { good: 'heal potions', amount: 5, price: 100 })).toContain(
    'cannot supply'
  );
});

test('expired orders release stock, clear their personal goal, and do not invent completed trades', async () => {
  const f = supplier();
  acceptWorkOrder(f.session, 2, 'Ada', { good: 'boards', amount: 20, price: 100 });
  updatePersonalGoals(f.ctx);
  expect(f.checkpoint.personal?.goals[0]?.kind).toBe('supply-order');
  required(f.checkpoint.personal?.orders[0]).until = Date.now() - 1;
  expect(await orderTurn(f.ctx)).toBe(false);
  updatePersonalGoals(f.ctx);
  expect(f.checkpoint.personal?.orders[0]?.state).toBe('cancelled');
  expect(f.checkpoint.personal?.goals[0]?.state).toBe('blocked');
  expect(orderDemand(f.session, 'boards')).toBe(0);
  expect(sharedMemoryLine(f.checkpoint, 2)).toBeUndefined();
});

test('completed delivery is remembered once, and saves the resulting goal progress', () => {
  const f = supplier();
  acceptWorkOrder(f.session, 2, 'Ada', { good: 'boards', amount: 20, price: 100 });
  updatePersonalGoals(f.ctx);
  finishWorkOrder(f.session, 2, 'boards');
  finishWorkOrder(f.session, 2, 'boards');
  updatePersonalGoals(f.ctx);
  expect(f.checkpoint.personal?.episodes.filter((e) => e.result === 'completed')).toHaveLength(1);
  expect(sharedMemoryLine(f.checkpoint, 2)).toContain('last deal worked out');
  expect(f.checkpoint.personal?.goals[0]?.state).toBe('completed');
  const restored = JSON.parse(JSON.stringify(f.checkpoint));
  expect(personalMemory(restored).orders[0]?.state).toBe('completed');
});

test('earning goals influence work choices and survive reconnects', () => {
  const f = supplier();
  f.template.archetype = { ...required(f.template.archetype), primarySkills: ['Lumberjacking'] };
  const goal = required(updatePersonalGoals(f.ctx));
  expect(goal.kind).toBe('skill');
  expect(goalPhaseBias(f.ctx, 'work')).toBeGreaterThan(goalPhaseBias(f.ctx, 'visit'));
  const restored = JSON.parse(JSON.stringify(f.checkpoint));
  expect(personalMemory(restored).goals[0]?.id).toBe(goal.id);
});

test('learning uses actual work and setbacks, without treating a gift as production', () => {
  const f = supplier();
  const now = Date.now();
  f.checkpoint.goal = { kind: 'lumberjacking', phase: 'chopping', note: 'working' };
  learnWork(f.session, f.checkpoint, f.template, now);
  required(f.world.entities.get(20)).amount = 100;
  learnWork(f.session, f.checkpoint, f.template, now + 2000);
  expect(f.checkpoint.personal?.strategies[0]?.productive).toBe(0);
  for (let i = 2; i <= 4; i++) {
    tally(f.session, 'chopped');
    learnWork(f.session, f.checkpoint, f.template, now + i * 2000);
  }
  expect(learnedPlaceCost(f.checkpoint, 1, { x: 100, y: 100 }, now + 8000)).toBeLessThan(0);
  expect(learnedPlaceCost(f.checkpoint, 2, { x: 100, y: 100 }, now + 8000)).toBe(0);
  expect(learnedPlaceCost(f.checkpoint, 1, { x: 100, y: 100 }, now + 8 * 86400_000)).toBe(0);
  f.checkpoint.goal.phase = 'escaping';
  learnWork(f.session, f.checkpoint, f.template, now + 10_000);
  expect(f.checkpoint.personal?.strategies[0]?.setbacks).toBe(1);
});

test('session habits are stable through restart, and start a new session only after the saved break', () => {
  const f = supplier();
  const now = Date.now();
  const habits = sessionHabits(f.checkpoint, 1, now);
  expect(habits.sessionUntil - now).toBeGreaterThanOrEqual(45 * 60_000);
  expect(habits.sessionUntil - now).toBeLessThanOrEqual(150 * 60_000);
  habits.offlineUntil = now + 20_000;
  const restored = JSON.parse(JSON.stringify(f.checkpoint));
  expect(sessionHabits(restored, 1, now + 1000)).toEqual(habits);
  const resumed = sessionHabits(restored, 1, now + 30_000);
  expect(resumed.offlineUntil).toBe(0);
  expect(resumed.style).toBe(habits.style);
  expect(resumed.sessionUntil).toBeGreaterThan(now + 30_000);
});

for (const confirmed of [true, false])
  test(`a delivery ${confirmed ? 'completes after' : 'cannot complete without'} an observed secure swap`, async () => {
    const f = supplier();
    acceptWorkOrder(f.session, 2, 'Ada', { good: 'boards', amount: 20, price: 100 });
    f.session.giveToMobile = async (serial) => {
      required(f.world.entities.get(serial)).amount = 10;
      f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x1bd7, amount: 20, parent: 100 });
      f.world.entities.set(31, { serial: 31, kind: 'item', graphic: 0xeed, amount: 100, parent: 101 });
      f.world.trade = {
        mine: 100,
        theirs: 101,
        partner: 2,
        name: 'Ada',
        accepted: { me: false, them: false },
        closed: false
      };
    };
    f.session.acceptTrade = () => {
      required(f.world.trade).closed = true;
      f.world.entities.delete(30);
      if (confirmed) required(f.world.entities.get(11)).amount = 1100;
      else required(f.world.entities.get(20)).amount = 30;
    };
    await orderTurn(f.ctx);
    expect(f.checkpoint.personal?.orders[0]?.state).toBe(confirmed ? 'completed' : 'ready');
    expect(f.checkpoint.personal?.episodes.some((e) => e.result === 'completed')).toBe(confirmed);
  });

test('a natural session break reaches a real stopping place and saves the next login before ending', async () => {
  const { enableSessionHabits } = await import('../src/resident-context');
  const { serviceLocations } = await import('../src/locations');
  const { SessionBreak, sessionBreakTurn } = await import('../src/session-habits');
  const f = supplier();
  const bank = required(serviceLocations('Britain', 'banker')[0]);
  f.world.position = { ...required(f.world.position), ...bank };
  enableSessionHabits(f.session);
  const habits = sessionHabits(f.checkpoint, 1);
  habits.sessionUntil = Date.now() - 1;
  let saved = false;
  f.ctx.persist = () => {
    saved = true;
  };
  await expect(sessionBreakTurn(f.ctx)).rejects.toBeInstanceOf(SessionBreak);
  expect(saved).toBe(true);
  expect(habits.offlineUntil).toBeGreaterThan(Date.now());
});

test('a due session break is deferred for a customer order or death', async () => {
  const { enableSessionHabits } = await import('../src/resident-context');
  const { sessionBreakTurn } = await import('../src/session-habits');
  const f = supplier();
  enableSessionHabits(f.session);
  const habits = sessionHabits(f.checkpoint, 1);
  habits.sessionUntil = Date.now() - 1;
  acceptWorkOrder(f.session, 2, 'Ada', { good: 'boards', amount: 20, price: 100 });
  await sessionBreakTurn(f.ctx);
  expect(habits.offlineUntil).toBe(0);
  required(f.checkpoint.personal?.orders[0]).state = 'cancelled';
  required(f.world.status).hits = 0;
  await sessionBreakTurn(f.ctx);
  expect(habits.offlineUntil).toBe(0);
});
