import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { proposeGoals, riskBudget, workDeathRisk } from '../src/goal-policy';
import { type GoalActions, goalSituation, residentTurn } from '../src/goal-turn';
import { rememberPlan } from '../src/plan-memory';
import type { ProfessionContext } from '../src/profession';
import { chooseGoal, type GoalSituation } from '../src/resident-goal';
import type { Checkpoint } from '../src/store';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();

// A strong swordsman among creatures; what counts as risk is what it cannot beat.
function fighterAmong(graphic: number, name: string, count: number, swingingAtMe = false) {
  const f = socialFixture('fighter');
  f.template.behavior.activities = [];
  f.checkpoint.funds = { bank: 1000, at: Date.now() };
  for (const skill of ['Swords', 'Tactics', 'Anatomy', 'Healing'])
    f.world.skills.set(skillId(skill), { base: 100, value: 100, cap: 100, lock: 0 });
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0xf61, parent: 1, layer: 1 });
  const at = required(f.world.position);
  for (let i = 0; i < count; i++)
    f.world.entities.set(500 + i, {
      serial: 500 + i,
      kind: 'mobile',
      graphic,
      name,
      notoriety: 6,
      hits: 100,
      maxHits: 100,
      position: { ...at, x: at.x + 4 + i }
    });
  if (swingingAtMe) {
    f.world.swings.set(500, { target: 1, at: Date.now() });
    f.world.healthChanges.push({ at: Date.now(), damage: 2, hits: 98, maxHits: 100, healed: 0 });
  }
  const ctx = {
    ...f.ctx,
    serial: 1,
    city: 'Britain',
    backpack: () => 10,
    carried: (parent = 10) => f.world.childrenOf(parent),
    status: () => required(f.world.status)
  } as unknown as ProfessionContext;
  return goalSituation(ctx);
}

test('creatures a fighter can beat are not risk: it keeps working among them', () => {
  const state = fighterAmong(39, 'a mongbat', 8);
  expect(state.safe).toBe(true);
  expect(state.planning?.deathRisk ?? 1).toBeLessThanOrEqual(riskBudget(state));
});

test('creatures it cannot beat are risk', () => {
  const state = fighterAmong(12, 'a dragon', 4);
  expect(state.planning?.deathRisk ?? 0).toBeGreaterThan(riskBudget(state));
});

test('a fight it is winning keeps a fighter safe: being hit is its work', () => {
  const state = fighterAmong(39, 'a mongbat', 1, true);
  expect(state.safe).toBe(true);
  expect(state.planning?.deathRisk ?? 1).toBeLessThan(1);
});

test('being hit by what it cannot beat makes it unsafe', () => {
  expect(fighterAmong(12, 'a dragon', 1, true).safe).toBe(false);
});

// Recovery, the securing gate and work admission judge one number: the risk of the situation now.
// Past deaths raise the expected loss of a plan, never block work outright: no bank trip or wait
// can lower them.
const situation = (deathRisk: number): GoalSituation => ({
  safe: true,
  ready: true,
  learning: false,
  earningNeeded: false,
  evidence: {
    funds: 1000,
    bankKnown: true,
    gold: 0,
    products: 0,
    orders: 0,
    goods: 0,
    skills: { '41': 50 },
    health: 100
  },
  planning: {
    condition: 'same-build',
    coarse: 'coarse',
    available: true,
    riskTolerance: 0.5,
    exposed: 0,
    securable: 0,
    escapeKnown: true,
    uncertainty: 0.2,
    deathRisk
  }
});

for (const [risk, works] of [
  [0.002, true],
  [0.5, false]
] as const)
  test(`after past deaths, a situation of risk ${risk} ${works ? 'is worked' : 'is recovered from'}`, () => {
    const c: Checkpoint = { goal: null, memories: [], relationships: {} };
    const s = situation(0.002);
    for (let i = 0; i < 3; i++) rememberPlan(c, chooseGoal(c, s, 1000 + i), 'died', 'Death observed', s, 2000 + i);
    // After the short replan cooldown a death sets (resident-goal.ts).
    const proposals = proposeGoals(c, situation(risk), 300_000);
    const earn = required(proposals.find((p) => p.kind === 'earn'));
    const recover = required(proposals.find((p) => p.kind === 'recover'));
    expect(earn.allowed).toBe(works);
    expect(recover.allowed).toBe(!works);
    expect((workDeathRisk(situation(risk)) ?? 1) > riskBudget(situation(risk))).toBe(!works);
  });

function strandedNearDragons() {
  const f = socialFixture('fighter');
  f.template.behavior.activities = [];
  f.world.entities.delete(11);
  required(f.world.status).gold = 0;
  f.checkpoint.funds = { bank: 1000, at: Date.now() };
  const at = required(f.world.position);
  for (let i = 0; i < 10; i++)
    f.world.entities.set(600 + i, {
      serial: 600 + i,
      kind: 'mobile',
      graphic: 12,
      name: 'a dragon',
      notoriety: 6,
      position: { ...at, x: at.x + 12 + i }
    });
  let walks = 0;
  const phases: string[] = [];
  const ctx = {
    ...f.ctx,
    serial: 1,
    city: 'Britain',
    deadline: Date.now() + 60_000,
    backpack: () => 10,
    carried: (parent = 10) => f.world.childrenOf(parent),
    count: () => 0,
    status: () => required(f.world.status),
    practise: async () => 1,
    progress: {},
    log: () => {},
    phase: (phase: string) => phases.push(phase),
    navigate: async () => {
      walks++;
      // Each walk lands somewhere new: the loop guard must not depend on standing still.
      f.world.position = { ...required(f.world.position), x: required(f.world.position).x + 20 };
    }
  } as unknown as ProfessionContext;
  return { f, ctx, phases, walks: () => walks };
}

test('nothing carried is never a reason for a bank trip, and leaving threats is not repeated', async () => {
  const { ctx, phases, walks } = strandedNearDragons();
  let settles = 0;
  const actions: GoalActions = {
    trade: 'fighter',
    keep: () => true,
    settle: async () => {
      settles++;
    }
  };
  for (let turn = 0; turn < 5; turn++) await residentTurn(ctx, actions);
  expect(settles).toBe(0);
  expect(phases).not.toContain('securing-assets');
  expect(walks()).toBeLessThanOrEqual(3);
  expect(phases.at(-1)).toBe('recovery-wait');
});
