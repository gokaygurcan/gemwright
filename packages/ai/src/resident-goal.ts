import { AsyncLocalStorage } from 'node:async_hooks';

import type { PlayerSession } from '@gemwright/network/session';

import { proposeGoals, riskBudget, selectGoal } from './goal-policy';
import { describeIntent, type PlanningContext, planningCondition, type ResidentIntent } from './intent';
import { intentEvidence, intentRationale } from './intent-evidence';
import { lifeEvent } from './life-events';
import { type PlanAssumption, progressAssumption } from './plan-assumptions';
import { planBudget, reserveSpend, spendWithinPlan } from './plan-budget';
import { type PlanOutcome, rememberPlan } from './plan-memory';
import { observePlans } from './plan-observations';
import type { Checkpoint } from './store';
import { bindCheckpoint } from './telemetry';
import { earnedGold, skillGrowth, type WorkEvidence, workEvidence } from './work-evidence';

export type GoalKind = 'recover' | 'equip' | 'order' | 'commitment' | 'earn' | 'learn';
export type GoalStep = 'recover' | 'equip' | 'order' | 'commitment' | 'trade' | 'settle' | 'income';
export interface ResidentGoal {
  kind: GoalKind;
  key: string;
  step: GoalStep;
  started: number;
  until: number;
  stepUntil: number;
  budget: number;
  before: WorkEvidence;
  blocker?: string;
  incomeTrade?: string;
  intent?: ResidentIntent;
}
export interface GoalMemory {
  active?: ResidentGoal;
  suspended?: ResidentGoal;
  settle?: boolean;
  outcomes?: PlanOutcome[];
  assumptions?: PlanAssumption[];
  failed?: Record<string, { until: number; reason: string; condition?: string }>;
  last?: { key: string; result: 'completed' | 'blocked'; reason: string; at: number };
}
export interface GoalSituation {
  evidence: WorkEvidence;
  planning?: PlanningContext;
  safe: boolean;
  ready: boolean;
  learning: boolean;
  order?: string;
  commitment?: string;
  completedCommitment?: string;
  earningNeeded: boolean;
  settlementReady?: boolean;
}
const assessments = new WeakMap<
  Checkpoint,
  {
    safe: boolean;
    reason: string;
    available: boolean | null;
    deathRisk: number | null;
    riskBudget: number;
    exposed: number | null;
    uncertainty: number | null;
  }
>();
const bindings = new WeakMap<PlayerSession, Checkpoint>();
const residents = new WeakMap<Checkpoint, PlayerSession>();
const snapshots = new WeakMap<PlayerSession, () => GoalSituation>();
const planSaves = new WeakMap<PlayerSession, () => void>();
export const registerGoal = (
  session: PlayerSession,
  checkpoint: Checkpoint,
  situation?: () => GoalSituation,
  persist?: () => void
) => {
  bindCheckpoint(checkpoint, session);
  bindings.set(session, checkpoint);
  residents.set(checkpoint, session);
  if (situation && persist) {
    snapshots.set(session, situation);
    planSaves.set(session, persist);
    observePlans(session, { checkpoint, situation, persist });
  }
};
export function goalStatus(session: PlayerSession) {
  const memory = bindings.get(session)?.workGoal;
  const active = memory?.active;
  return {
    active: active
      ? {
          id: active.intent?.id,
          kind: active.kind,
          step: active.step,
          started: active.started,
          until: active.until,
          stepUntil: active.stepUntil,
          blocker: active.blocker
        }
      : null,
    assessment: bindings.has(session) ? (assessments.get(bindings.get(session) as Checkpoint) ?? null) : null,
    last: memory?.last ?? null
  };
}
export function interruptGoal(session: PlayerSession, reason: string) {
  const checkpoint = bindings.get(session);
  if (checkpoint) blockGoal(checkpoint, reason, Date.now(), snapshots.get(session)?.());
  leases.delete(session);
}
export function failResidentGoal(session: PlayerSession, reason: string) {
  const active = bindings.get(session)?.workGoal?.active;
  if (active) active.blocker = reason.slice(0, 240);
}

// A second loop soon after the first means the plan layer did not find another course: the goal that
// kept looping is held off for longer, while the trade goes on with its own work.
export function extendGoalBlock(session: PlayerSession, ms: number, now = Date.now()) {
  const memory = bindings.get(session)?.workGoal;
  const key = memory?.last?.key;
  if (!memory?.failed || !key) return;
  const failure = memory.failed[key];
  if (failure) failure.until = Math.max(failure.until, now + ms);
}

const leases = new WeakMap<PlayerSession, number>();
const permits = new WeakMap<PlayerSession, 'optional' | GoalStep>();
const permission = new AsyncLocalStorage<{ session: PlayerSession; step: 'optional' | GoalStep }>();
const permitFor = (session: PlayerSession) => {
  const current = permission.getStore();
  return current?.session === session ? current.step : permits.get(session);
};
export const goalAllows = (session: PlayerSession, step: 'optional' | 'income' | 'equip' | 'commitment') =>
  permitFor(session) === step;
export const goalControlled = (session: PlayerSession) =>
  permits.has(session) || permission.getStore()?.session === session;
export function goalPermission<T>(
  session: PlayerSession,
  step: 'optional' | GoalStep,
  run: () => Promise<T>
): Promise<T> {
  return permission.run({ session, step }, run);
}
export function attachGoal(session: PlayerSession) {
  permits.set(session, 'trade');
}

export function blockGoal(checkpoint: Checkpoint, reason: string, now = Date.now(), state?: GoalSituation) {
  const memory = checkpoint.workGoal;
  const goal = memory?.active;
  if (!memory || !goal) return;
  memory.failed ??= {};
  const failureKey = goal.step === 'income' ? 'income' : goal.key;
  memory.failed[failureKey] = {
    until: now + 2 * 60_000,
    reason: reason.slice(0, 240),
    condition: goal.intent?.condition
  };
  const failed = memory.failed;
  const keys = Object.keys(failed).sort((a, b) => (failed[a]?.until ?? 0) - (failed[b]?.until ?? 0));
  for (const key of keys.slice(0, Math.max(0, keys.length - 16))) delete memory.failed[key];
  if (goal.step === 'settle') {
    memory.failed.settle = { until: now + 2 * 60_000, reason };
    delete memory.settle;
  }
  rememberPlan(checkpoint, goal, 'blocked', reason, state, now);
  memory.last = { key: goal.key, result: 'blocked', reason: reason.slice(0, 240), at: now };
  const session = residents.get(checkpoint);
  if (session)
    lifeEvent(
      session,
      'objective',
      'failed',
      { ...memory.last },
      `objective:${session.world.serial}:${goal.started}:${goal.key}`
    );
  delete memory.active;
}
export function goalResult(goal: ResidentGoal, state: GoalSituation): string | undefined {
  if (!state.safe) return;
  if (goal.kind === 'recover') return 'Health recovered';
  if (goal.kind === 'equip') return state.ready ? 'Work tool observed and ready' : undefined;
  if (goal.kind === 'order')
    return state.evidence.orders > goal.before.orders && state.order !== goal.key
      ? 'Deed accepted by vendor'
      : undefined;
  if (goal.kind === 'commitment') return state.completedCommitment === goal.key ? 'Commitment completed' : undefined;
  if (goal.kind === 'earn' && earnedGold(goal.before, state.evidence) > 0) return 'Net funds increased';
  if (
    goal.kind === 'learn' &&
    skillGrowth(goal.before, state.evidence) > 0 &&
    goal.before.funds - state.evidence.funds <= goal.budget
  )
    return 'Trade skill increased within budget';
}

export function chooseGoal(checkpoint: Checkpoint, state: GoalSituation, now = Date.now()): ResidentGoal {
  checkpoint.workGoal ??= {};
  const memory = checkpoint.workGoal;
  const died = (goal: ResidentGoal) =>
    memory.outcomes?.some((event) => event.id === goal.intent?.id && event.result === 'died');
  if (memory.active && died(memory.active))
    blockGoal(checkpoint, 'Previous intent ended in observed death; replan before working', now, state);
  if (memory.suspended && died(memory.suspended)) delete memory.suspended;
  const condition = planningCondition(state);
  const blocked = (key: string) => {
    const failed = memory.failed?.[key];
    return !!failed && failed.until > now && (!failed.condition || failed.condition === condition);
  };
  const budget = riskBudget(state);
  const activeRisk =
    memory.active && memory.active.kind !== 'recover'
      ? proposeGoals(checkpoint, state, now).find((proposal) => proposal.kind === memory.active?.kind)?.estimate
          .deathRisk
      : state.planning?.deathRisk;
  assessments.set(checkpoint, {
    safe: state.safe,
    reason: !state.safe
      ? 'unhealthy-or-threatened'
      : state.planning?.available === false
        ? 'missing-observations'
        : activeRisk === null
          ? 'unknown-risk'
          : (activeRisk ?? 0) > budget
            ? 'risk-over-budget'
            : 'work-permitted',
    available: state.planning?.available ?? null,
    deathRisk: activeRisk ?? null,
    riskBudget: budget,
    exposed: state.planning?.exposed ?? null,
    uncertainty: state.planning?.uncertainty ?? null
  });
  if (state.planning && (!state.planning.available || activeRisk === null || (activeRisk ?? 0) > budget))
    state = { ...state, safe: false };
  if (
    memory.active &&
    (!Number.isFinite(memory.active.until) ||
      !Number.isFinite(memory.active.stepUntil) ||
      !memory.active.before?.skills)
  )
    delete memory.active;
  const old = memory.active;
  if (old && old.before.bankKnown !== state.evidence.bankKnown) {
    old.before.funds = state.evidence.funds;
    old.before.bankKnown = state.evidence.bankKnown;
  }
  if (
    old &&
    ['earn', 'learn'].includes(old.kind) &&
    old.step !== 'income' &&
    state.settlementReady !== false &&
    state.evidence.products > old.before.products &&
    state.evidence.goods > old.before.goods
  )
    memory.settle = true;
  const result = old ? goalResult(old, state) : undefined;
  if (old && !state.safe && old.kind !== 'recover') {
    memory.suspended = old;
    delete memory.active;
  } else if (old && old.kind === 'order' && old.key !== state.order && state.evidence.orders <= old.before.orders)
    blockGoal(checkpoint, 'Deed no longer observed; do not claim it was fulfilled', now, state);
  else if (old && old.kind === 'commitment' && old.key !== state.commitment && old.key !== state.completedCommitment)
    blockGoal(checkpoint, 'Commitment ended without observed completion', now, state);
  else if (old && result) {
    rememberPlan(checkpoint, old, 'completed', result, state, now);
    memory.last = { key: old.key, result: 'completed', reason: result, at: now };
    const session = residents.get(checkpoint);
    if (session)
      lifeEvent(
        session,
        'objective',
        'completed',
        { ...memory.last, after: state.evidence },
        `objective:${session.world.serial}:${old.started}:${old.key}`
      );
    delete memory.active;
  } else if (old?.blocker) blockGoal(checkpoint, old.blocker, now, state);
  else if (old && (now >= old.until || now >= old.stepUntil))
    blockGoal(checkpoint, 'No verified outcome within the action deadline', now, state);
  else if (
    old &&
    old.before.bankKnown === state.evidence.bankKnown &&
    old.before.funds - state.evidence.funds > old.budget
  )
    blockGoal(checkpoint, 'Training budget exhausted; earn before spending more', now, state);
  if (
    memory.active &&
    state.order &&
    memory.active.key !== state.order &&
    !['recover', 'equip'].includes(memory.active.kind) &&
    !blocked(state.order)
  )
    delete memory.active;
  if (!memory.active && state.safe && memory.suspended) {
    const resume = memory.suspended;
    delete memory.suspended;
    if (
      resume.until > now &&
      (resume.kind !== 'order' || resume.key === state.order) &&
      (resume.kind !== 'commitment' || resume.key === state.commitment) &&
      (!state.planning ||
        (proposeGoals(checkpoint, state, now).find((proposal) => proposal.kind === resume.kind)?.estimate.deathRisk ??
          1) <= budget)
    ) {
      resume.stepUntil = Math.min(resume.until, now + 10 * 60_000);
      memory.active = resume;
    }
  }
  if (memory.active) {
    const goal = memory.active;
    if (goal.step === 'income' && !goal.incomeTrade && state.ready && !blocked('earn') && !blocked('learn')) {
      goal.step = 'trade';
      goal.stepUntil = Math.min(goal.until, now + 10 * 60_000);
    }
    if (
      state.evidence.products > goal.before.products &&
      state.evidence.goods > goal.before.goods &&
      goal.step === 'trade' &&
      state.settlementReady !== false
    ) {
      goal.step = 'settle';
      goal.stepUntil = Math.min(goal.until, now + 10 * 60_000);
    }
    const proposal = proposeGoals(checkpoint, state, now).find((candidate) => candidate.kind === goal.kind);
    if (proposal) {
      if (!goal.intent?.budget && goal.kind !== 'learn') goal.budget = planBudget(goal.kind, state);
      goal.intent ??= describeIntent(goal, state, proposal.estimate, proposal.utility, proposal.riskBudget);
      const assumption = progressAssumption(
        checkpoint,
        goal.step === 'income' ? 'income' : goal.kind,
        goal.intent.condition,
        now
      );
      if (!assumption.evidence.length) assumption.checkedAt = goal.started;
      goal.intent.assumptions = [assumption];
      Object.assign(goal.intent, intentRationale(goal, state), {
        evidence: intentEvidence(goal, state),
        currentStep: goal.step,
        estimate: proposal.estimate,
        utility: proposal.utility,
        riskBudget: proposal.riskBudget
      });
    }
    return goal;
  }
  const proposal = selectGoal(checkpoint, state, now);
  const { kind, key } = proposal;
  const step: GoalStep =
    (kind === 'learn' || kind === 'earn') && memory.settle && !blocked('settle')
      ? 'settle'
      : kind === 'learn'
        ? 'trade'
        : kind === 'earn'
          ? !state.ready || blocked('earn') || blocked('learn')
            ? 'income'
            : 'trade'
          : kind;
  memory.active = {
    kind,
    key,
    step,
    started: now,
    until: now + 30 * 60_000,
    stepUntil: now + 10 * 60_000,
    budget: planBudget(kind, state),
    before: structuredClone(state.evidence)
  };
  memory.active.intent = describeIntent(memory.active, state, proposal.estimate, proposal.utility, proposal.riskBudget);
  memory.active.intent.assumptions = [
    progressAssumption(checkpoint, step === 'income' ? 'income' : kind, condition, now)
  ];
  return memory.active;
}
export function goalGuard(session: PlayerSession, now = Date.now()): string | undefined {
  const goal = bindings.get(session)?.workGoal?.active;
  if (!goal) return;
  if (goal.blocker) return goal.blocker;
  if (now >= goal.until || now >= goal.stepUntil) return `Objective ${goal.key} exceeded its bounded action time`;
  const checkpoint = bindings.get(session);
  if (checkpoint) {
    const current = workEvidence(session, checkpoint);
    if (goal.before.bankKnown === current.bankKnown && goal.before.funds - current.funds > goal.budget)
      return 'Intent spending budget exhausted';
  }
}
export function plannedSpendAllowed(session: PlayerSession, cost: number): boolean {
  const checkpoint = bindings.get(session);
  const goal = checkpoint?.workGoal?.active;
  if (!goal || !checkpoint) return true;
  if (!spendWithinPlan(goal, cost)) return false;
  const current = workEvidence(session, checkpoint);
  return goal.before.bankKnown === current.bankKnown && goal.before.funds - current.funds + cost <= goal.budget;
}

export function leaseGoal(session: PlayerSession, goal: ResidentGoal) {
  leases.set(session, Math.min(goal.until, goal.stepUntil));
}

export function reservePlannedSpend(session: PlayerSession, cost: number) {
  const settle = reserveSpend(bindings.get(session)?.workGoal?.active, cost);
  planSaves.get(session)?.();
  return (result: 'confirmed' | 'refused' | 'unknown') => {
    settle(result);
    planSaves.get(session)?.();
  };
}
