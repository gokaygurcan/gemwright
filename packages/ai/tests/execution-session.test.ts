import { expect, test } from 'bun:test';

import { PlayerSession } from '@gemwright/network/session';

import { mockShard } from '../../network/tests/mock-shard';
import { DangerInterrupt, InteractionInterrupt } from '../src/action-errors';
import { takingUrgentAction } from '../src/action-purpose';
import { interruptForDanger } from '../src/danger-response';
import {
  actionScope,
  executionFor,
  independentAction,
  installExecution,
  reserveInteraction
} from '../src/execution-session';
import { registerLifeEvents } from '../src/life-events';
import { startPerception } from '../src/perception-session';
import { runtimeMetrics } from '../src/telemetry-metrics';
import { observePerception } from '../src/telemetry-perception';

async function fixture(options: Parameters<typeof mockShard>[0] = {}) {
  const shard = await mockShard(options);
  const session = new PlayerSession(shard.config);
  registerLifeEvents(session, 'test-resident', 'Test', () => {});
  startPerception(session);
  observePerception(session);
  installExecution(session);
  await session.connect({ username: 'test-player', password: 'test-password' }, { slot: 0 });
  session.world.entities.set(0x40000002, { serial: 0x40000002, kind: 'item', graphic: 0xe86, parent: 0x40000001 });
  return {
    shard,
    session,
    close: async () => {
      session.close();
      await shard.close();
    }
  };
}
function attack() {
  const packet = Buffer.alloc(10);
  packet[0] = 0x2f;
  packet.writeUInt32BE(999, 2);
  packet.writeUInt32BE(123, 6);
  return packet;
}

test('real incoming aggression interrupts a pending action immediately and lets safety move', async () => {
  const { session, shard, close } = await fixture();
  session.setActivityCheck(() => {
    if (!takingUrgentAction(session)) interruptForDanger(session, false);
  });
  try {
    let staleSent = false;
    const started = Date.now();
    const work = actionScope(session, 'work', 'wait for crafting', async () => {
      await session.waitFor(() => false, 'craft result', 5000);
      staleSent = true;
      session.say('stale');
    }).catch((error) => error);
    shard.broadcast(attack());
    expect(await work).toBeInstanceOf(DangerInterrupt);
    expect(Date.now() - started).toBeLessThan(500);
    expect(staleSent).toBe(false);
    await actionScope(session, 'escape', 'leave danger', async () => {
      expect(await session.walk(2)).toBe(true);
    });
    expect(shard.moves()).toBe(1);
    expect(runtimeMetrics.snapshot().histograms.work_interrupt_ms?.count).toBeGreaterThan(0);
    expect(runtimeMetrics.snapshot().histograms.safety_authorize_ms?.count).toBeGreaterThan(0);
    expect(shard.errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a delayed movement acknowledgement retains ownership through safety preemption', async () => {
  const { session, shard, close } = await fixture({ delayWalkMs: 80 });
  try {
    const work = actionScope(session, 'work', 'walk to workshop', () => session.walk(2)).catch((error) => error);
    while (shard.moves() < 1) await Bun.sleep(1);
    shard.broadcast(attack());
    expect(await work).toBeInstanceOf(DangerInterrupt);
    await actionScope(session, 'escape', 'move away', () => session.walk(4));
    expect(shard.moves()).toBe(2);
    expect(shard.errors).toEqual([]);
    expect(session.phase).toBe('ready');
  } finally {
    await close();
  }
});

test('an open player trade blocks routine movement and closing it permits a fresh turn', async () => {
  const { session, shard, close } = await fixture();
  try {
    session.world.trade = {
      partner: 2,
      mine: 10,
      theirs: 20,
      name: 'Player',
      accepted: { me: false, them: false },
      closed: false
    };
    await expect(actionScope(session, 'work', 'continue route', () => session.walk(2))).rejects.toBeInstanceOf(
      InteractionInterrupt
    );
    expect(shard.moves()).toBe(0);
    await independentAction(session, 'trade', 'inspect gift', async () => {
      expect(executionFor(session).arbiter.current()?.kind).toBe('trade');
    });
    session.world.trade.closed = true;
    await actionScope(session, 'work', 'new route', () => session.walk(2));
    expect(shard.moves()).toBe(1);
  } finally {
    await close();
  }
});

test('interaction reservation interrupts work without inheriting combat authority', async () => {
  const { session, close } = await fixture();
  try {
    const work = actionScope(session, 'work', 'routine', () => session.waitFor(() => false, 'result', 5000)).catch(
      (error) => error
    );
    await independentAction(session, 'interaction', 'answer', async () => {
      expect(takingUrgentAction(session)).toBe(false);
      reserveInteraction(session, Date.now() + 60_000);
      session.say('Hello');
    });
    expect(await work).toBeInstanceOf(InteractionInterrupt);
    reserveInteraction(session, 0);
    await actionScope(session, 'work', 'resume after conversation', async () => {});
  } finally {
    await close();
  }
});

test('an interrupted targeting request cancels its late cursor before another skill can own it', async () => {
  const { session, shard, close } = await fixture({ cursorDelayMs: 80 });
  try {
    const work = actionScope(session, 'work', 'use tool', async () => {
      session.use(0x40000002);
      await session.waitFor(() => session.world.target !== null, 'tool cursor', 1000, { resource: 'target' });
    }).catch((error) => error);
    await Bun.sleep(15);
    shard.broadcast(attack());
    expect(await work).toBeInstanceOf(DangerInterrupt);
    await session.waitFor(() => shard.commands.includes(0x6c), 'late cursor cancellation', 1000);
    expect(session.world.target).toBeNull();
    expect(shard.errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an interrupted cursor that never arrives is assumed refused instead of dropping the session', async () => {
  const { session, shard, close } = await fixture({ skipCursor: true });
  try {
    const work = actionScope(session, 'work', 'use tool', async () => {
      session.use(0x40000002);
      await session.waitFor(() => session.world.target !== null, 'tool cursor', 5000, { resource: 'target' });
    }).catch((error) => error);
    await Bun.sleep(15);
    shard.broadcast(attack());
    await work;
    // The quarantine lapses without a cursor: the shard never opened one, so nothing is uncertain.
    await Bun.sleep(4300);
    expect(session.phase).toBe('ready');
    expect(session.reconnectable).toBe(false);
    expect(() => session.use(0x40000002)).not.toThrow();
  } finally {
    await close();
  }
}, 8000);

test('a canceled context request never performs its automatic retry', async () => {
  const { session, shard, close } = await fixture();
  try {
    const work = actionScope(session, 'work', 'ask for vendor menu', () => session.context(123)).catch(
      (error) => error
    );
    while (!shard.commands.includes(0xbf)) await Bun.sleep(1);
    shard.broadcast(attack());
    expect(await work).toBeInstanceOf(DangerInterrupt);
    await Bun.sleep(300);
    expect(shard.commands.filter((opcode) => opcode === 0xbf)).toHaveLength(1);
    expect(shard.errors).toEqual([]);
  } finally {
    await close();
  }
});

test('target wait timeout quarantines a cursor even when the routine catches the timeout', async () => {
  const { session, shard, close } = await fixture({ cursorDelayMs: 80 });
  try {
    await actionScope(session, 'work', 'use tool', async () => {
      session.use(0x40000002);
      await session
        .waitFor(() => session.world.target !== null, 'tool cursor', 10, { resource: 'target' })
        .catch(() => {});
      expect(() => session.use(0x40000002)).toThrow('interrupted targeting cursor');
    });
    await session.waitFor(() => shard.commands.includes(0x6c), 'late cursor cancellation', 1000);
    expect(session.world.target).toBeNull();
    expect(shard.commands.filter((opcode) => opcode === 0x06)).toHaveLength(1);
    expect(shard.errors).toEqual([]);
  } finally {
    await close();
  }
});

test('continuing attack observations do not cancel a target owned by the safety action', async () => {
  const { session, shard, close } = await fixture({ cursorDelayMs: 40 });
  try {
    await actionScope(session, 'escape', 'use safety item', async () => {
      session.use(0x40000002);
      shard.broadcast(attack());
      await session.waitFor(() => session.world.target !== null, 'safety cursor', 1000, { resource: 'target' });
      expect(session.world.target?.id).toBe(42);
      session.target(null);
    });
    expect(shard.errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an explicit plan is correlated with execution and interrupted without claiming completion', async () => {
  const { session, shard, close } = await fixture();
  const { chooseGoal } = await import('../src/resident-goal');
  const { bindIntent } = await import('../src/execution-session');
  const { registerLifeEvents } = await import('../src/life-events');
  const events: import('../src/life-events').LifeEvent[] = [];
  registerLifeEvents(session, 'test-resident', 'Test resident', (event) => events.push(event));
  const checkpoint: import('../src/store').Checkpoint = { goal: null, memories: [], relationships: {} };
  const situation: import('../src/resident-goal').GoalSituation = {
    safe: true,
    ready: true,
    learning: false,
    earningNeeded: false,
    order: 'order:42',
    evidence: { funds: 1000, bankKnown: true, gold: 0, skills: {}, products: 0, orders: 0, goods: 0, health: 100 }
  };
  try {
    const plan = chooseGoal(checkpoint, situation);
    const work = actionScope(session, 'work', 'prepare order', async () => {
      if (!plan.intent) throw new Error('Missing plan intent');
      bindIntent(session, plan.intent);
      session.say('Working on my order');
      await session.waitFor(() => false, 'crafting result', 5000);
    }).catch((error) => error);
    shard.broadcast(attack());
    expect(await work).toBeInstanceOf(DangerInterrupt);
    expect(
      events.some(
        (event) =>
          event.type === 'action_lifecycle' &&
          event.details.intentId === plan.intent?.id &&
          event.details.stage === 'interrupted'
      )
    ).toBe(true);
    expect(checkpoint.workGoal?.last).toBeUndefined();
    situation.safe = false;
    expect(chooseGoal(checkpoint, situation).kind).toBe('recover');
    situation.safe = true;
    expect(chooseGoal(checkpoint, situation).intent?.id).toBe(plan.intent?.id);
  } finally {
    await close();
  }
});

test('death updates calibrated plan memory from the server event without waiting for another work turn', async () => {
  const { session, shard, close } = await fixture();
  const { chooseGoal, registerGoal } = await import('../src/resident-goal');
  const checkpoint: import('../src/store').Checkpoint = { goal: null, memories: [], relationships: {} };
  const state: import('../src/resident-goal').GoalSituation = {
    safe: true,
    ready: true,
    learning: false,
    earningNeeded: false,
    evidence: { funds: 1000, bankKnown: true, gold: 0, skills: {}, products: 0, orders: 0, goods: 0, health: 100 }
  };
  let saves = 0;
  try {
    const goal = chooseGoal(checkpoint, state);
    registerGoal(
      session,
      checkpoint,
      () => ({ ...state, safe: false, evidence: { ...state.evidence, health: 0 } }),
      () => {
        saves++;
      }
    );
    shard.broadcast(Buffer.from([0x2c, 0]));
    await session.waitFor(
      () => checkpoint.workGoal?.outcomes?.some((event) => event.result === 'died') ?? false,
      'observed plan death',
      1000
    );
    expect(checkpoint.workGoal?.outcomes?.[0]).toMatchObject({ id: goal.intent?.id, died: true });
    expect(saves).toBe(1);
    shard.broadcast(Buffer.from([0x2c, 0]));
    await session.waitFor(() => (session.world.received.get(0x2c) ?? 0) >= 2, 'duplicate death', 1000);
    expect(saves).toBe(1);
    expect(checkpoint.workGoal?.assumptions?.[0]?.failures).toBe(1);
    chooseGoal(checkpoint, state);
    expect(checkpoint.workGoal?.last?.reason).toContain('observed death');
    expect(checkpoint.workGoal?.active?.intent?.id).not.toBe(goal.intent?.id);
  } finally {
    await close();
  }
});
