import { expect, test } from 'bun:test';

import { CommandRejected } from '@gemwright/network/errors';

import { chargedPurchase } from '../src/bank-gold';
import { proposeGoals } from '../src/goal-policy';
import { type PlanEstimate, planningCondition } from '../src/intent';
import { progressAssumption } from '../src/plan-assumptions';
import { reserveSpend, spendWithinPlan } from '../src/plan-budget';
import { calibrateEstimate, calibration } from '../src/plan-calibration';
import { rememberPlan } from '../src/plan-memory';
import { blockGoal, chooseGoal, type GoalSituation, registerGoal } from '../src/resident-goal';
import type { Checkpoint } from '../src/store';
import { workEvidence } from '../src/work-evidence';
import { behaviorFixture, required } from './behavior-fixture';

const now = 1_000_000_000;
const checkpoint = (): Checkpoint => ({ goal: null, memories: [], relationships: {} });
const situation = (): GoalSituation => ({
  safe: true,
  ready: true,
  learning: true,
  earningNeeded: false,
  evidence: {
    funds: 1000,
    bankKnown: true,
    gold: 100,
    products: 0,
    orders: 0,
    goods: 4,
    skills: { '41': 50 },
    health: 100
  },
  planning: {
    condition: 'same-build',
    available: true,
    riskTolerance: 0.5,
    exposed: 100,
    securable: 100,
    escapeKnown: true,
    uncertainty: 0.2,
    deathRisk: 0.002
  }
});
const prior: PlanEstimate = {
  source: 'policy-estimate',
  wealth: 50,
  capability: 1,
  loss: 0.2,
  cost: 5,
  deathRisk: 0.002,
  uncertainty: 0.5
};

test('utility coefficients adapt to observed skill returns and underestimated losses', () => {
  const c = checkpoint(),
    s = situation();
  const before = calibration(c, now);
  chooseGoal(c, s, now);
  s.evidence.skills['41'] = 51;
  s.evidence.funds -= 10;
  chooseGoal(c, s, now + 300_000);
  s.evidence.funds += 100;
  s.learning = false;
  chooseGoal(c, s, now + 600_000);
  const learned = calibration(c, now + 600_000);
  expect(learned.alpha).toBeGreaterThan(before.alpha);
  expect(learned.beta).toBe(before.beta); // A planned training investment is not an accidental loss.
  const goal = required(c.workGoal?.active);
  s.safe = false;
  s.evidence.health = 0;
  s.evidence.funds -= 100;
  rememberPlan(c, goal, 'died', 'Observed death and lost carried gold', s, now + 660_000);
  expect(calibration(c, now + 660_000).beta).toBeGreaterThan(before.beta);
  const restored = JSON.parse(JSON.stringify(c)) as Checkpoint;
  expect(calibration(restored, now + 660_000)).toEqual(calibration(c, now + 660_000));
});

test('mortality and return estimates use observed outcomes; interruption is censored', () => {
  const c = checkpoint(),
    s = situation();
  s.learning = false;
  const goal = chooseGoal(c, s, now);
  s.safe = false;
  s.evidence.health = 0;
  s.evidence.funds -= 100;
  rememberPlan(c, goal, 'died', 'Death observed', s, now + 60_000);
  const estimate = calibrateEstimate(c, 'earn', planningCondition(s), prior, now + 60_000);
  expect(estimate.source).toBe('outcome-calibrated');
  expect(estimate.deathRisk).toBeGreaterThan(required(prior.deathRisk));
  expect(estimate.wealth).toBeLessThan(prior.wealth);
  const alternative = required(
    proposeGoals(c, { ...s, safe: true }, now + 60_000).find((proposal) => proposal.kind === 'earn')
  );
  expect(alternative.estimate.method).toBe('income');
  expect(required(alternative.estimate.deathRisk)).toBeLessThanOrEqual(alternative.riskBudget);
  const uncertain = checkpoint(),
    pending = situation();
  pending.learning = false;
  const interrupted = chooseGoal(uncertain, pending, now);
  rememberPlan(uncertain, interrupted, 'blocked', 'Connection interrupted; outcome unknown', undefined, now + 60_000);
  const censored = calibrateEstimate(uncertain, 'earn', planningCondition(pending), prior, now + 60_000);
  expect(censored.deathRisk).toBe(prior.deathRisk);
  expect(censored.calibration?.effectiveSamples).toBe(0);
  expect(censored.calibration?.censored).toBe(1);
});

test('a death with unknown funds still calibrates risk without inventing an asset loss', () => {
  const c = checkpoint(),
    s = situation();
  s.learning = false;
  const goal = chooseGoal(c, s, now);
  s.evidence.bankKnown = false;
  s.safe = false;
  rememberPlan(c, goal, 'died', 'Observed death', s, now + 1000);
  expect(c.workGoal?.outcomes?.[0]?.loss).toBeNull();
  expect(calibrateEstimate(c, 'earn', planningCondition(s), prior, now + 1000).deathRisk).toBeGreaterThan(
    required(prior.deathRisk)
  );
});

test('intent carries readable evidence, contextual reasons and an invalidatable assumption', () => {
  const c = checkpoint(),
    s = situation();
  s.order = 'order:123';
  const goal = chooseGoal(c, s, now),
    intent = required(goal.intent);
  expect(intent.why).toContain('order:123');
  expect(intent.prerequisites.some((line) => line.includes('1000'))).toBe(true);
  expect(intent.evidence.some((evidence) => evidence.kind === 'observed' && evidence.source.includes('deed'))).toBe(
    true
  );
  expect(intent.budget.maxSpend).toBeGreaterThan(0);
  blockGoal(c, 'Required material unavailable', now + 1, s);
  expect(progressAssumption(c, 'order', intent.condition, now + 2)).toMatchObject({
    status: 'invalidated',
    reason: 'Required material unavailable',
    evidence: [intent.id]
  });
  expect(progressAssumption(c, 'order', intent.condition, now + 120_002).status).toBe('unverified');
  expect(progressAssumption(c, 'order', 'new-material-context', now + 2).status).toBe('unverified');
});

for (const kind of ['earn', 'order'] as const)
  test(`${kind} has a reserved spending budget enforced through real purchase accounting`, async () => {
    const f = behaviorFixture();
    f.checkpoint.funds = { bank: 0, at: now };
    const s = situation();
    s.learning = false;
    s.evidence = workEvidence(f.session, f.checkpoint);
    if (kind === 'order') s.order = 'order:1';
    const goal = chooseGoal(f.checkpoint, s, now);
    registerGoal(f.session, f.checkpoint);
    const budget = required(goal.intent?.budget);
    expect(budget.maxSpend).toBeGreaterThan(0);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const purchase = chargedPurchase({ ...f.ctx, backpack: () => 10 }, budget.maxSpend, async () => {
      await waiting;
      required(f.world.entities.get(11)).amount = 1000 - budget.maxSpend;
    });
    expect(budget.reserved).toBe(budget.maxSpend);
    let sent = false;
    await expect(
      chargedPurchase({ ...f.ctx, backpack: () => 10 }, 1, async () => {
        sent = true;
      })
    ).rejects.toThrow('intent spending budget');
    expect(sent).toBe(false);
    release();
    await purchase;
    expect(budget.reserved).toBe(0);
    expect(budget.spent).toBe(budget.maxSpend);
    expect(spendWithinPlan(goal, 1)).toBe(false);
  });

test('known refusals release reservations and unknown purchase results retain them', async () => {
  const f = behaviorFixture();
  f.checkpoint.funds = { bank: 0, at: now };
  const s = situation();
  s.learning = false;
  s.evidence = workEvidence(f.session, f.checkpoint);
  const goal = chooseGoal(f.checkpoint, s, now);
  registerGoal(f.session, f.checkpoint);
  await expect(
    chargedPurchase({ ...f.ctx, backpack: () => 10 }, 10, async () => {
      throw new CommandRejected('vendor-insufficient-funds', 'refused');
    })
  ).rejects.toThrow();
  expect(goal.intent?.budget.reserved).toBe(0);
  const settle = reserveSpend(goal, 10);
  settle('unknown');
  expect(goal.intent?.budget.reserved).toBe(10);
  expect(goal.intent?.budget.spent).toBe(0);
});

test('purchase dispatch waits for the persisted budget reservation', async () => {
  const f = behaviorFixture();
  const { registerDurability } = await import('../src/session-durability');
  let release!: () => void;
  const flushed = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerDurability(f.session, () => flushed);
  let sent = false;
  const purchase = chargedPurchase({ ...f.ctx, backpack: () => 10 }, 10, async () => {
    sent = true;
  });
  await Bun.sleep(0);
  expect(sent).toBe(false);
  release();
  await purchase;
  expect(sent).toBe(true);
});
