import type { PlayerSession } from '@gemwright/network/session';

import { canPause, takingUrgentAction } from './action-purpose';
import { Blocked } from './blocked';
import { lasting } from './lasting';
import { lifeEvent } from './life-events';
import { logger } from './log';
import { extendGoalBlock, failResidentGoal, goalGuard, interruptGoal } from './resident-goal';
import { positiveProgress, type WorkEvidence, workEvidence } from './work-evidence';

const IDLE_MS = 5 * 60_000;
const FORCE_MS = 20 * 60_000;
const REPEATS = 3;
const STRIKE_MS = 10 * 60_000;

// A repeated step is a legal, explainable impossibility of the plan — like an unreachable road or an
// empty shop — so it is a Blocked: the goal is blocked and the trade takes another course inside the
// same session. It used to be a plain Error, which ended the run and made the population log the
// resident out and back in: the login churn around every loop.
export class Stuck extends Blocked {
  constructor(message: string) {
    super('stuck', message);
    this.name = 'Stuck';
  }
}

interface Watch {
  steps: string[];
  phase: string;
  progress: WorkEvidence;
  progressAt: number;
  at: { x: number; y: number };
  checkedAt: number;
  trail: { x: number; y: number; at: number }[];
}
const watches = new WeakMap<PlayerSession, Watch>();
const pending = new WeakMap<PlayerSession, string>();
const forced = new WeakMap<PlayerSession, number>();
const names = new WeakMap<PlayerSession, string>();
const kept = lasting('loops');
const strikes = new WeakMap<PlayerSession, { count: number; at: number }>();

// Twenty minutes of nothing but its job after a loop.
export const forcedToWork = (session: PlayerSession) => (forced.get(session) ?? 0) > Date.now();

// Numbers and coordinates do not make a step different.
const kindOf = (phase: string, note: string) => `${phase}: ${note.replace(/-?\d+/g, '#')}`.slice(0, 120);
// Bounded recovery: paced by the goal's own deadline (goalGuard) and its planning gates, so its
// phases are not the repeated-step pattern the guard exists to break.
const recovering = (phase: string) => /^(recovering|recovering-health|recovery-wait|securing-assets)$/.test(phase);

function trigger(session: PlayerSession, watch: Watch, reason: string) {
  const now = Date.now();
  watch.steps = [];
  watch.progressAt = now;
  forced.set(session, now + FORCE_MS);
  pending.set(session, reason);
  interruptGoal(session, reason);
  const name = names.get(session) ?? 'resident';
  // A second loop soon after the first means the plan layer did not find another course: the goal
  // that kept looping is held off for longer, and the trade goes on with its own work. A loop is
  // never a reason to end the session (that made the population log the resident in and out).
  const previous = strikes.get(session);
  const count = previous && now - previous.at < STRIKE_MS ? previous.count + 1 : 1;
  strikes.set(session, { count, at: now });
  if (count >= 2) {
    extendGoalBlock(session, 10 * 60_000, now);
    logger('loop-watch').info(`[loop] ${name}: second loop soon after the first; the goal waits ten minutes`);
  }
  logger('loop-watch').info(`[loop] ${name}: ${reason}`);
  kept.set(`${session.world.serial ?? 0}|${name}|${now}|${reason.slice(0, 160)}`, now + 24 * 3_600_000);
}

// The same run of 2 to 6 steps three times over, nothing gained in between.
function repeated(steps: string[]) {
  for (let size = 2; size <= 6; size++) {
    if (steps.length < size * REPEATS) continue;
    const run = steps.slice(-size);
    if (new Set(run).size < 2) continue;
    let times = 0;
    for (let end = steps.length; end >= size && times < REPEATS; end -= size) {
      if (!steps.slice(end - size, end).every((s, i) => s === run[i])) break;
      times++;
    }
    if (times >= REPEATS) return run;
  }
  return undefined;
}

function watchOf(session: PlayerSession) {
  const now = Date.now();
  const found = watches.get(session);
  if (found) return found;
  const watch: Watch = {
    steps: [],
    phase: '',
    progress: workEvidence(session),
    progressAt: now,
    at: session.world.position ?? { x: 0, y: 0 },
    checkedAt: now,
    trail: []
  };
  watches.set(session, watch);
  return watch;
}

export function watchStep(session: PlayerSession, name: string, phase: string, note: string) {
  lifeEvent(session, 'activity', 'observed', { phase, note });
  if (/^(setback|loop|blocked|retreating|death)$/.test(phase)) {
    if (phase === 'setback' || phase === 'loop') interruptGoal(session, note);
    else failResidentGoal(session, note);
  }
  names.set(session, name);
  const watch = watchOf(session);
  watch.phase = phase;
  const current = workEvidence(session);
  if (positiveProgress(watch.progress, current)) {
    watch.progressAt = Date.now();
    watch.steps = [];
    return;
  }
  if (interactionActive(session) || takingUrgentAction(session)) return;
  if (recovering(phase)) return;
  watch.steps = [...watch.steps.slice(-40), kindOf(phase, note)];
  const run = repeated(watch.steps);
  if (
    !run &&
    watch.steps.length >= 12 &&
    new Set(watch.steps.slice(-12)).size === 1 &&
    Date.now() - watch.progressAt > 60_000 &&
    !interactionActive(session)
  )
    trigger(session, watch, `Repeated ${phase} without a verified gain; abandoning this plan`);
  if (run) trigger(session, watch, `the same steps three times with nothing gained: ${run.join(' → ')}`);
}

function interactionActive(session: PlayerSession) {
  return !!session.world.trade && !session.world.trade.closed;
}

export function noteNavigationStep(session: PlayerSession) {
  const watch = watchOf(session);
  const here = session.world.position;
  const now = Date.now();
  if (!here || now - (watch.trail.at(-1)?.at ?? 0) < 1000) return;
  watch.trail = [...watch.trail.filter((p) => now - p.at < 90_000), { x: here.x, y: here.y, at: now }];
  if (
    watch.trail.length < 20 ||
    now - watch.progressAt < 90_000 ||
    takingUrgentAction(session) ||
    interactionActive(session)
  )
    return;
  const width = Math.max(...watch.trail.map((p) => p.x)) - Math.min(...watch.trail.map((p) => p.x));
  const height = Math.max(...watch.trail.map((p) => p.y)) - Math.min(...watch.trail.map((p) => p.y));
  if (width <= 12 && height <= 12) {
    watch.trail = [];
    trigger(session, watch, 'Repeated small-area movement without a verified gain; abandoning this plan');
  }
}

// Raised inside the runner's ordinary setback handling; urgent survival actions finish first.
export function checkLoop(session: PlayerSession) {
  if (interactionActive(session) && canPause(session)) return;
  const now = Date.now();
  const blocked = takingUrgentAction(session) ? undefined : goalGuard(session, now);
  if (blocked) {
    interruptGoal(session, blocked);
    const watch = watchOf(session);
    watch.progressAt = now;
    watch.checkedAt = now;
    watch.steps = [];
    pending.delete(session);
    throw new Stuck(blocked);
  }
  const watch = watchOf(session);
  if (now - watch.checkedAt >= 5000) {
    watch.checkedAt = now;
    const current = workEvidence(session);
    if (positiveProgress(watch.progress, current)) {
      watch.progressAt = now;
      watch.steps = [];
    }
    // A running recovery action holds the idle clock: its bound is the goal deadline, not the guard.
    if (recovering(watch.phase)) watch.progressAt = now;
    if (now - watch.progressAt > IDLE_MS && !takingUrgentAction(session) && !interactionActive(session))
      trigger(session, watch, `five minutes without a verified gain (${watch.phase || 'no phase'})`);
  }
  const loop = pending.get(session);
  if (!loop || takingUrgentAction(session)) return;
  pending.delete(session);
  throw new Stuck(`Going in circles (${loop})`);
}

// Time since a verified gain (drives.ts).
export function sinceProgress(session: PlayerSession) {
  const watch = watches.get(session);
  return watch ? Date.now() - watch.progressAt : 0;
}
