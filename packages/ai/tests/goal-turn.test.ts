import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { chargedPurchase } from '../src/bank-gold';
import { type GoalActions, residentTurn } from '../src/goal-turn';
import { lifeTurn } from '../src/life';
import type { ProfessionContext } from '../src/profession';
import { blockGoal, goalAllows, goalControlled, goalPermission } from '../src/resident-goal';
import { tally } from '../src/work-evidence';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function fixture(trade: string) {
  const f = socialFixture(trade);
  f.template.id = trade === 'miner' ? 'minoc-miner' : `test-${trade}`;
  f.template.behavior.activities = trade === 'miner' ? ['mine'] : trade === 'lumberjack' ? ['chop'] : [];
  f.template.behavior.trainingGoals = {};
  required(f.template.archetype).primarySkills = ['Mining'];
  required(f.template.archetype).supportingSkills = [];
  f.world.skills.set(skillId('Mining'), { base: 100, value: 100, cap: 100, lock: 0 });
  f.world.entities.set(12, { serial: 12, kind: 'item', graphic: trade === 'lumberjack' ? 0xf43 : 0xe85, parent: 10 });
  f.checkpoint.funds = { bank: 1000, at: Date.now() };
  f.terrain.findStatics = () => [];
  f.session.refreshStatus = async () => {};
  const logs: string[] = [];
  const ctx: ProfessionContext = {
    ...f.ctx,
    serial: 1,
    city: 'Britain',
    deadline: Date.now() + 60000,
    backpack: () => 10,
    carried: (parent = 10) => f.world.childrenOf(parent),
    count: (graphic) =>
      f.world
        .childrenOf(10)
        .filter((i) => i.graphic === graphic)
        .reduce((n, i) => n + (i.amount ?? 1), 0),
    status: () => required(f.world.status),
    practise: async () => 0,
    progress: {},
    log: (line) => logs.push(line)
  };
  return { ...f, ctx, logs };
}

for (const trade of ['miner', 'lumberjack', 'fighter', 'tamer', 'thief'])
  test(`${trade}: work remains active through production, sale and banking`, async () => {
    const f = fixture(trade);
    let settlements = 0;
    let optional = 0;
    const actions: GoalActions = {
      trade,
      keep: () => true,
      settle: async () => {
        settlements++;
        f.world.entities.delete(30);
        required(f.world.entities.get(11)).amount = 0;
        f.checkpoint.funds = { bank: 2050, at: Date.now() };
      },
      optional: async () => {
        optional++;
        expect(f.checkpoint.workGoal?.active).toBeUndefined();
        return false;
      }
    };
    f.checkpoint.life = { phase: 'work', until: Date.now() + 60 * 60_000 };
    expect(await residentTurn(f.ctx, actions)).toBe(false);
    expect(goalControlled(f.session)).toBe(true);
    expect(goalAllows(f.session, 'optional')).toBe(false);
    expect(await lifeTurn(f.ctx)).toBe(false);
    tally(f.session, 'mined');
    required(f.world.status).weight = 170;
    f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x1bf2, amount: 20, parent: 10 });
    expect(await residentTurn(f.ctx, actions)).toBe(true);
    expect(settlements).toBe(1);
    expect(optional).toBe(0);
    await residentTurn(f.ctx, actions);
    expect(f.checkpoint.workGoal?.last).toMatchObject({ key: 'earn', result: 'completed' });
    // A completed goal is a step of the work phase; the agenda is consulted only when it ends.
    expect(optional).toBe(0);
    f.checkpoint.life.until = 0;
    await residentTurn(f.ctx, actions);
    expect(optional).toBe(1);
  });

test('recovery takes priority over an accepted order, then returns to it without taking a break', async () => {
  const f = fixture('miner');
  f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x2258, parent: 10 });
  let orders = 0,
    recoveries = 0,
    optional = 0;
  const actions: GoalActions = {
    trade: 'miner',
    keep: () => true,
    order: async () => {
      orders++;
      return true;
    },
    recover: async () => {
      recoveries++;
      required(f.world.status).hits = 100;
    },
    optional: async () => {
      optional++;
      return false;
    }
  };
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(orders).toBe(1);
  required(f.world.status).hits = 20;
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(recoveries).toBe(1);
  expect(orders).toBe(1);
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(orders).toBe(2);
  expect(optional).toBe(0);
});

test('buying a tool releases the equipment objective only after the tool is observed', async () => {
  const f = fixture('miner');
  f.world.entities.delete(12);
  let preparations = 0;
  const actions: GoalActions = {
    trade: 'miner',
    keep: () => true,
    prepare: async () => {
      preparations++;
      f.world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xe85, parent: 10 });
    }
  };
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(preparations).toBe(1);
  expect(await residentTurn(f.ctx, actions)).toBe(false);
  expect(f.checkpoint.workGoal?.last).toMatchObject({ key: 'equip', result: 'completed' });
});

test('a failed order is recorded and does not monopolize the next turn', async () => {
  const f = fixture('miner');
  f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x2258, parent: 10 });
  let orders = 0;
  const actions: GoalActions = {
    trade: 'miner',
    keep: () => true,
    order: async () => {
      orders++;
      return false;
    }
  };
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(await residentTurn(f.ctx, actions)).toBe(false);
  expect(orders).toBe(1);
  expect(f.checkpoint.workGoal?.last?.result).toBe('blocked');
});

test('a training purchase cannot exceed its plan budget and permissions restore after an exception', async () => {
  const f = fixture('miner');
  required(f.world.skills.get(skillId('Mining'))).base = 50;
  await residentTurn(f.ctx, { trade: 'miner', keep: () => true });
  let purchases = 0;
  await expect(
    chargedPurchase(f.ctx, 301, async () => {
      purchases++;
    })
  ).rejects.toThrow('budget');
  expect(purchases).toBe(0);
  await expect(
    goalPermission(f.session, 'optional', async () => {
      throw new Error('interrupted');
    })
  ).rejects.toThrow('interrupted');
  expect(goalAllows(f.session, 'optional')).toBe(false);
  blockGoal(f.checkpoint, 'End test');
});

test('unchanged work turns do not repeatedly write the same objective checkpoint', async () => {
  const f = fixture('miner');
  let saves = 0;
  f.ctx.persist = () => {
    saves++;
  };
  const actions = { trade: 'miner', keep: () => true };
  expect(await residentTurn(f.ctx, actions)).toBe(false);
  const initial = saves;
  expect(initial).toBe(1);
  for (let i = 0; i < 5; i++) expect(await residentTurn(f.ctx, actions)).toBe(false);
  expect(saves).toBe(initial);
});

test('unavailable income still yields when supporting skills have nothing left to train', async () => {
  const f = fixture('miner');
  await residentTurn(f.ctx, { trade: 'miner', keep: () => true });
  blockGoal(f.checkpoint, 'No primary work now');
  let practised = false;
  f.ctx.practise = async () => {
    practised = true;
    return 0;
  };
  f.ctx.check = () => {
    if (practised) throw new Error('shutdown interrupts income retry delay');
  };
  let failure: unknown;
  try {
    await residentTurn(f.ctx, { trade: 'miner', keep: () => true });
  } catch (error) {
    failure = error;
  }
  expect(practised).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('shutdown interrupts income retry delay');
});

test('blocked methods keep a safe, equipped resident at its own work while the planner waits', async () => {
  const f = fixture('miner');
  // No admissible trade goal: earning and side income are cooling down, nothing else applies.
  f.checkpoint.workGoal = {
    failed: {
      earn: { until: Date.now() + 600_000, reason: 'test' },
      income: { until: Date.now() + 600_000, reason: 'test' }
    }
  };
  let recovered = 0;
  const actions = {
    trade: 'miner',
    keep: () => true,
    recover: async () => {
      recovered++;
    }
  };
  expect(await residentTurn(f.ctx, actions)).toBe(false);
  expect(f.checkpoint.workGoal?.active?.step).toBe('trade');
  expect(f.checkpoint.workGoal?.last).toBeUndefined();
  expect(recovered).toBe(0);
}, 20_000);

test('healthy risk recovery secures carried assets instead of invoking health setbacks or training', async () => {
  const f = fixture('miner');
  f.world.entities.delete(11);
  required(f.world.status).gold = 0;
  f.checkpoint.funds = { bank: 0, at: Date.now() };
  f.template.behavior.riskTolerance = 0;
  f.world.entities.set(42, { serial: 42, kind: 'item', graphic: 0x1bf2, parent: 10, amount: 1000 });
  let settled = 0,
    recovered = 0;
  expect(
    await residentTurn(f.ctx, {
      trade: 'miner',
      keep: () => true,
      settle: async () => {
        settled++;
        f.world.entities.delete(42);
        // The live view is cached per world revision; a server change arrives as a packet.
        f.world.revision++;
        f.checkpoint.funds = { bank: 500, at: Date.now() };
      },
      recover: async () => {
        recovered++;
      }
    })
  ).toBe(true);
  expect(settled).toBe(1);
  expect(recovered).toBe(0);
  expect(f.checkpoint.goal?.phase).not.toBe('training');
});

test('full health does not complete recovery while the personal corpse is still pending', async () => {
  const f = fixture('fighter');
  f.checkpoint.workGoal = { failed: { recover: { until: Date.now() + 600_000, reason: 'Previous recovery failed' } } };
  f.checkpoint.hunting = {
    loot: [],
    killsSinceBank: 0,
    pending: 'return',
    recovery: { stage: 'corpse', diedAt: new Date().toISOString(), ownerName: 'Test fighter', attempts: 0 }
  };
  let recoveries = 0;
  const actions: GoalActions = {
    trade: 'fighter',
    keep: () => true,
    recover: async () => {
      recoveries++;
      required(f.checkpoint.hunting?.recovery).stage = 'ready';
    }
  };
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(recoveries).toBe(1);
  expect(f.checkpoint.workGoal?.active?.kind).toBe('recover');
  expect(f.checkpoint.workGoal?.last?.result).not.toBe('completed');
  await residentTurn(f.ctx, actions);
  expect(f.checkpoint.workGoal?.last).toMatchObject({ key: 'recover', result: 'completed' });
});
