import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { type CombatCapability, comparableCapability } from '../src/combat-capability';
import { encounterAdvice, rememberExperience } from '../src/experience';
import { proposeGoals, riskBudget, selectGoal } from '../src/goal-policy';
import { planningCondition } from '../src/intent';
import { planAdvice } from '../src/plan-memory';
import { blockGoal, chooseGoal, type GoalSituation, goalAllows, goalPermission } from '../src/resident-goal';
import type { Checkpoint } from '../src/store';
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
    gold: 0,
    products: 0,
    orders: 0,
    goods: 4,
    skills: { '41': 50 },
    health: 100
  },
  planning: {
    condition: 'skills50-tool1',
    coarse: 'coarse-condition',
    available: true,
    riskTolerance: 0.5,
    exposed: 100,
    securable: 100,
    escapeKnown: true,
    uncertainty: 0.2,
    deathRisk: 0.002
  }
});

test('intent explains prerequisites, future payoff and evidence for a multi-step order', () => {
  const c = checkpoint(),
    s = situation();
  s.order = 'order:123';
  const goal = chooseGoal(c, s, now);
  expect(goal.intent).toMatchObject({
    outcome: 'Fulfil the accepted bulk order',
    currentStep: 'order',
    estimate: { source: 'policy-estimate' }
  });
  expect(goal.intent?.steps).toEqual(['equip', 'order', 'settle']);
  expect(goal.intent?.completionEvidence).toContain('Vendor acceptance');
  s.evidence.products += 10;
  chooseGoal(c, s, now + 1);
  expect(c.workGoal?.last).toBeUndefined();
  s.evidence.orders++;
  delete s.order;
  chooseGoal(c, s, now + 2);
  expect(c.workGoal?.outcomes?.[0]).toMatchObject({ result: 'completed', key: 'order:123' });
});

test('risk constraint rejects profitable work with stale evidence or excessive death risk', () => {
  for (const patch of [{ available: false }, { deathRisk: null }, { deathRisk: 0.9 }]) {
    const s = situation();
    Object.assign(required(s.planning), patch);
    const proposals = proposeGoals(checkpoint(), s, now);
    expect(proposals.find((p) => p.kind === 'earn')?.allowed).toBe(false);
    expect(selectGoal(checkpoint(), s, now).kind).toBe('recover');
  }
  const s = situation();
  const usual = riskBudget(s);
  Object.assign(required(s.planning), { uncertainty: 1 });
  expect(riskBudget(s)).toBeLessThan(usual);
  Object.assign(required(s.planning), { uncertainty: 0.2 });
  Object.assign(required(s.planning), { securable: 5000, escapeKnown: false });
  expect(riskBudget(s)).toBeLessThan(usual);
});

test('a risky context suspends work and resumes it only after current prerequisites are safe', () => {
  const c = checkpoint(),
    s = situation();
  s.order = 'order:123';
  const original = chooseGoal(c, s, now);
  Object.assign(required(s.planning), { deathRisk: 1 });
  expect(chooseGoal(c, s, now + 1).kind).toBe('recover');
  expect(c.workGoal?.suspended?.intent?.id).toBe(original.intent?.id);
  Object.assign(required(s.planning), { deathRisk: 0.002 });
  expect(chooseGoal(c, s, now + 2).intent?.id).toBe(original.intent?.id);
});

test('unchanged failures change choice; materially changed skills reopen the candidate', () => {
  const c = checkpoint(),
    s = situation();
  for (let i = 0; i < 6; i++) {
    const goal = chooseGoal(c, s, now + i * 600_000);
    if (goal.kind !== 'learn') break;
    blockGoal(c, 'No verified skill gain', now + i * 600_000);
  }
  expect(selectGoal(c, s, now + 3600_000).kind).toBe('earn');
  expect(planAdvice(c, 'learn', planningCondition(s), now + 3600_000).samples).toBeGreaterThanOrEqual(2);
  Object.assign(required(s.planning), { condition: 'skills90-tool1' });
  expect(selectGoal(c, s, now + 3600_000).kind).toBe('learn');
  expect(planAdvice(c, 'learn', planningCondition(s), now + 86400_001).penalty).toBe(0);
});

test('a changed prerequisite reopens a short cooldown without waiting for its timer', () => {
  const c = checkpoint(),
    s = situation();
  s.ready = false;
  expect(chooseGoal(c, s, now).kind).toBe('equip');
  blockGoal(c, 'No affordable tool', now);
  expect(chooseGoal(c, s, now + 1).step).toBe('income');
  delete c.workGoal?.active;
  Object.assign(required(s.planning), { condition: 'new-funds-new-tool-availability' });
  expect(chooseGoal(c, s, now + 2).kind).toBe('equip');
});

test('learning requires observed capability gains and bounded memory survives serialization', () => {
  const c = checkpoint(),
    s = situation();
  chooseGoal(c, s, now);
  s.evidence.funds += 100;
  chooseGoal(c, s, now + 1);
  expect(c.workGoal?.last).toBeUndefined();
  s.evidence.skills['41'] = 51;
  chooseGoal(c, s, now + 2);
  const restored = JSON.parse(JSON.stringify(c)) as Checkpoint;
  expect(restored.workGoal?.outcomes?.[0]).toMatchObject({ result: 'completed', capability: 1, wealth: 100 });
  for (let i = 0; i < 50; i++) {
    delete c.workGoal?.active;
    chooseGoal(c, s, now + i + 3);
    blockGoal(c, 'blocked', now + i + 3);
  }
  expect(c.workGoal?.outcomes?.length).toBeLessThanOrEqual(32);
});

test('permissions are local to an async plan and do not leak into a concurrent action', async () => {
  const { session } = behaviorFixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const optional = goalPermission(session, 'optional', async () => {
    expect(goalAllows(session, 'optional')).toBe(true);
    await waiting;
    expect(goalAllows(session, 'optional')).toBe(true);
  });
  expect(goalAllows(session, 'optional')).toBe(false);
  await goalPermission(session, 'income', async () => {
    expect(goalAllows(session, 'optional')).toBe(false);
    expect(goalAllows(session, 'income')).toBe(true);
  });
  release();
  await optional;
  expect(goalAllows(session, 'optional')).toBe(false);
});

const capability = (swords: number): CombatCapability => ({
  skills: { [skillId('Swordsmanship')]: swords },
  armor: 20,
  maxHits: 100,
  weapons: [0xf61]
});
test('combat inference is revised after skill growth without rewriting observed defeats', () => {
  const c = checkpoint();
  const place = { map: 1, x: 100, y: 100 };
  for (let i = 0; i < 2; i++)
    rememberExperience(
      c,
      {
        id: `loss${i}`,
        kind: 'combat',
        at: now + i,
        ...place,
        body: 3,
        creatureName: 'a zombie',
        capability: capability(50),
        outcome: 'death',
        largestLossRatio: 0.5,
        lowestHealthRatio: 0,
        damageRatio: 1
      },
      now + i
    );
  const before = encounterAdvice(c, place, 3, now + 2, capability(50), 'a zombie');
  const after = encounterAdvice(c, place, 3, now + 2, capability(90), 'a zombie');
  expect(before.avoidUntil).toBeGreaterThan(now);
  expect(after.avoidUntil).toBe(0);
  expect(after.caution).toBeLessThan(before.caution);
  expect(c.experience?.events).toHaveLength(2);
  expect(c.experience?.events[0]?.kind).toBe('combat');
  expect(encounterAdvice(c, place, 3, now + 2, capability(90), 'a custom boss').samples).toBe(0);
  expect(comparableCapability(capability(50), capability(10))).toBe(1);
  const craft = { ...capability(50), skills: { ...capability(50).skills, [skillId('Blacksmith')]: 100 } };
  expect(comparableCapability(capability(50), craft)).toBe(1);
});

test('a safe resident whose recovery cannot lower a residual risk goes back to work instead of waiting', () => {
  const c = checkpoint(),
    s = situation();
  Object.assign(required(s.planning), { deathRisk: riskBudget(s) * 1.05 });
  expect(chooseGoal(c, s, now).kind).toBe('recover');
  blockGoal(c, 'Objective recover exceeded its bounded action time', now, s);
  const next = chooseGoal(c, s, now + 1);
  expect(next.step).not.toBe('wait');
  expect(next.kind).toBe('earn');
  // A threat is still no residual risk: nothing works through an attack.
  Object.assign(required(s.planning), { deathRisk: 1 });
  expect(chooseGoal(checkpoint(), s, now + 2).kind).toBe('recover');
});
