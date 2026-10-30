import { expect, test } from 'bun:test';

import { blockGoal, chooseGoal, type GoalSituation, type ResidentGoal } from '../src/resident-goal';
import type { Checkpoint } from '../src/store';
import { positiveProgress, tally, type WorkEvidence, workEvidence } from '../src/work-evidence';
import { behaviorFixture, required } from './behavior-fixture';

const evidence = (): WorkEvidence => ({
  skills: { '7': 50 },
  funds: 1000,
  bankKnown: true,
  gold: 0,
  products: 0,
  orders: 0,
  goods: 4,
  health: 100
});
const situation = (): GoalSituation => ({
  evidence: evidence(),
  safe: true,
  ready: true,
  learning: true,
  earningNeeded: false
});
const checkpoint = (): Checkpoint => ({ goal: null, memories: [], relationships: {} });

test('spending, damage, movement and inventory churn are not progress', () => {
  const high = evidence();
  for (const current of [
    { ...evidence(), funds: 900 },
    { ...evidence(), health: 10 },
    { ...evidence(), goods: 100 },
    evidence()
  ])
    expect(positiveProgress(high, current)).toBe(false);
  expect(positiveProgress(high, { ...evidence(), funds: 1001 })).toBe(true);
  expect(positiveProgress(high, { ...evidence(), funds: 900 })).toBe(false);
  expect(positiveProgress(high, { ...evidence(), funds: 1001 })).toBe(false);
});

test('skill loss and regain cannot manufacture repeated progress', () => {
  const high = evidence();
  expect(positiveProgress(high, { ...evidence(), skills: { '7': 49 } })).toBe(false);
  expect(positiveProgress(high, evidence())).toBe(false);
  expect(positiveProgress(high, { ...evidence(), skills: { '7': 50.1 } })).toBe(true);
});

test('learning a bank balance and moving coins to the bank are not income', () => {
  const high = { ...evidence(), funds: 10, bankKnown: false };
  expect(positiveProgress(high, evidence())).toBe(false);
  expect(positiveProgress(high, { ...evidence(), gold: 0 })).toBe(false);
  expect(positiveProgress(high, { ...evidence(), funds: 1005 })).toBe(true);
});

test('goods only become a successful earning plan after settlement produces net income', () => {
  const c = checkpoint(),
    s = situation();
  s.learning = false;
  const goal = chooseGoal(c, s, 1000);
  expect(goal.step).toBe('trade');
  s.evidence.products++;
  s.evidence.goods += 10;
  expect(chooseGoal(c, s, 2000).step).toBe('settle');
  expect(c.workGoal?.last).toBeUndefined();
  s.evidence.funds += 20;
  s.evidence.goods = 4;
  chooseGoal(c, s, 3000);
  expect(c.workGoal?.last).toMatchObject({ key: 'earn', result: 'completed', reason: 'Net funds increased' });
});

test('training may spend its bounded budget but cannot succeed by buying things', () => {
  const c = checkpoint(),
    s = situation();
  const goal = chooseGoal(c, s, 1000);
  expect(goal.kind).toBe('learn');
  expect(goal.budget).toBe(300);
  s.evidence.funds -= 20;
  s.evidence.goods += 10;
  expect(chooseGoal(c, s, 2000)).toBe(goal);
  expect(c.workGoal?.last).toBeUndefined();
  s.evidence.skills['7'] = 50.1;
  chooseGoal(c, s, 3000);
  expect(c.workGoal?.last?.result).toBe('completed');
  const c2 = checkpoint(),
    s2 = situation();
  chooseGoal(c2, s2, 1000);
  s2.evidence.funds -= 301;
  s2.evidence.skills['7'] = 50.1;
  expect(chooseGoal(c2, s2, 2000).step).toBe('income');
  expect(c2.workGoal?.last?.reason).toContain('budget');
});

test('an accepted deed preempts optional learning and persists until actual acceptance', () => {
  const c = checkpoint(),
    s = situation();
  chooseGoal(c, s, 1000);
  s.order = 'order:30';
  const goal = chooseGoal(c, s, 2000);
  expect(goal.key).toBe('order:30');
  s.evidence.products += 20;
  s.evidence.skills['7'] = 51;
  expect(chooseGoal(c, s, 3000)).toBe(goal);
  expect(c.workGoal?.last?.result).not.toBe('completed');
  s.evidence.orders++;
  delete s.order;
  chooseGoal(c, s, 4000);
  expect(c.workGoal?.last).toMatchObject({ key: 'order:30', result: 'completed' });
});

test('a lost deed or cancelled commitment is never reported as completed', () => {
  for (const kind of ['order', 'commitment'] as const) {
    const c = checkpoint(),
      s = situation();
    s[kind] = `${kind}:30`;
    chooseGoal(c, s, 1000);
    delete s[kind];
    chooseGoal(c, s, 2000);
    expect(c.workGoal?.last?.result).toBe('blocked');
  }
});

test('recovery interrupts and then resumes an accepted order without granting a work success', () => {
  const c = checkpoint(),
    s = situation();
  s.order = 'order:30';
  const order = chooseGoal(c, s, 1000);
  s.safe = false;
  s.evidence.health = 20;
  expect(chooseGoal(c, s, 2000).kind).toBe('recover');
  expect(c.workGoal?.suspended?.key).toBe(order.key);
  s.safe = true;
  s.evidence.health = 100;
  expect(chooseGoal(c, s, 3000).key).toBe(order.key);
  expect(c.workGoal?.last?.key).toBe('recover');
});

test('failed primary work chooses an income alternative instead of repeating the same routine', () => {
  const c = checkpoint(),
    s = situation();
  chooseGoal(c, s, 1000);
  blockGoal(c, 'No materials and no affordable stock', 2000);
  expect(chooseGoal(c, s, 3000).step).toBe('income');
});

test('walking or ongoing intermediate production cannot renew an objective forever', () => {
  const c = checkpoint(),
    s = situation();
  s.learning = false;
  const original = chooseGoal(c, s, 1000);
  s.evidence.products += 10;
  chooseGoal(c, s, original.stepUntil);
  expect(c.workGoal?.last?.reason).toContain('deadline');
  expect(c.workGoal?.active?.step).toBe('income');
});

test('serialized plans survive restarts and malformed plans are discarded', () => {
  const c = checkpoint(),
    s = situation();
  s.order = 'order:30';
  chooseGoal(c, s, 1000);
  const restored: Checkpoint = JSON.parse(JSON.stringify(c));
  expect(chooseGoal(restored, s, 2000).key).toBe('order:30');
  required(restored.workGoal).active = { kind: 'earn' } as ResidentGoal;
  expect(chooseGoal(restored, s, 3000).until).toBeGreaterThan(3000);
});

test('the observed work counter changes only on confirmed work signals, not inventory changes', () => {
  const f = behaviorFixture();
  const before = workEvidence(f.session);
  f.world.entities.set(42, { serial: 42, kind: 'item', graphic: 0x1bf2, parent: 10, amount: 100 });
  expect(workEvidence(f.session).products).toBe(before.products);
  tally(f.session, 'mined', 2);
  expect(workEvidence(f.session).products).toBe(before.products + 2);
});

test('a small harvest stays in production until the batch is ready to settle', () => {
  const c = checkpoint(),
    s = situation();
  s.learning = false;
  s.settlementReady = false;
  chooseGoal(c, s, 1000);
  s.evidence.products++;
  s.evidence.goods++;
  expect(chooseGoal(c, s, 2000).step).toBe('trade');
  expect(c.workGoal?.settle).toBeUndefined();
  s.settlementReady = true;
  expect(chooseGoal(c, s, 3000).step).toBe('settle');
});

test('shifting points between relevant skills is not net learning', () => {
  const c = checkpoint(),
    s = situation();
  s.evidence.skills = { '7': 50, '8': 50 };
  chooseGoal(c, s, 1000);
  s.evidence.skills = { '7': 51, '8': 49 };
  chooseGoal(c, s, 2000);
  expect(c.workGoal?.last).toBeUndefined();
});

test('an income alternative stays selected through its sale instead of switching when cooldown expires', () => {
  const c = checkpoint(),
    s = situation();
  chooseGoal(c, s, 1000);
  blockGoal(c, 'Missing cloth', 2000);
  const goal = chooseGoal(c, s, 3000);
  goal.incomeTrade = 'ore';
  expect(chooseGoal(c, s, 150000)).toBe(goal);
  expect(goal.step).toBe('income');
  s.evidence.funds += 100;
  chooseGoal(c, s, 151000);
  expect(c.workGoal?.last?.result).toBe('completed');
});

test('stale core work remains admissible while side income waits', () => {
  const cp = checkpoint();
  const state = { ...situation(), learning: false, coreStale: true };
  const work = chooseGoal(cp, state, 1000);
  expect(work).toMatchObject({ kind: 'earn', step: 'trade' });
  blockGoal(cp, 'Primary method unavailable', 2000, state);
  expect(chooseGoal(cp, state, 3000).step).toBe('wait');
  // Losing a required tool still allows an income method that can restore the prerequisite.
  state.ready = false;
  state.evidence.funds = 0;
  state.earningNeeded = true;
  cp.workGoal = { failed: { equip: { until: 100_000, reason: 'No affordable tool' } } };
  expect(chooseGoal(cp, state, 4000).step).toBe('income');
});

test('a wait does not fabricate recovery success or teach that recovery failed', () => {
  const cp = checkpoint();
  const state = { ...situation(), learning: false };
  cp.workGoal = {
    failed: {
      earn: { until: 500_000, reason: 'Blocked trade' },
      income: { until: 500_000, reason: 'Blocked income' }
    }
  };
  const wait = chooseGoal(cp, state, 1000);
  expect(wait.step).toBe('wait');
  expect(chooseGoal(cp, state, 2000)).toBe(wait);
  blockGoal(cp, 'Wait deadline reached', 130_000, state);
  expect(cp.workGoal?.failed?.recover).toBeUndefined();
  expect(cp.workGoal?.outcomes).toBeUndefined();
  expect(cp.workGoal?.assumptions).toBeUndefined();
  const next = chooseGoal(cp, state, 501_000);
  expect(next).toMatchObject({ kind: 'earn', step: 'trade' });
  expect(cp.workGoal?.last?.result).not.toBe('completed');
});
