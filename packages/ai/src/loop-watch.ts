import { lasting } from './lasting';
import { info } from './log';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';

// The loop guard (the life-goal plan, ROADMAP.md step 4). A resident is going in circles when,
// with nothing gained (no skill, gold or goods):
//   - the same run of steps comes round a third time, or
//   - five minutes pass without a step of its job (working, or walking toward its work).
// Then `Stuck` is raised from its runner's next check(), its current plan is dropped, and for the
// next twenty minutes it does its job only (forcedToWork): no errands, side trades, life phases or
// town trips. Each case is logged as `[loop]` and kept (lasting 'loops') for the analyzer's Loops
// page. Every runner reports its phases here (watchStep) and calls checkLoop in its check().
const IDLE_MS = 5 * 60_000;
const FORCE_MS = 20 * 60_000;
const REPEATS = 3;

export class Stuck extends Error {}

// Phases that are not the job itself: errands, trades on the side, breaks and setbacks. Anything
// else a runner reports (mining, hunting, fishing, crafting, taming, travelling to its work,
// resting between fights) is its job.
const ERRANDS =
  /^(restocking|selling|banking|banking-failed|replacing-equipment|replacement-purchased|supplies|earning|side-trade|escort-search|escort|begging|life|leisure|visit|teleporter|moongate-travel|moongate-arrival|moongate-retreat|training-travel|buying|buying-from-resident|waiting|stuck|blocked|setback|loop|reconcile|tidying|guiding|shopping|mount-search|mounting|selling-to-resident|work)$/;
// A break the resident earned (life.ts): not counted against it while it lasts.
const BREAKS = /^(leisure|visit)$/;

interface Watch {
  steps: string[];
  phase: string;
  progress: string;
  progressAt: number;
  jobAt: number;
  at: { x: number; y: number };
  checkedAt: number;
}
const watches = new WeakMap<PlayerSession, Watch>();
const pending = new WeakMap<PlayerSession, string>();
const forced = new WeakMap<PlayerSession, number>();
const names = new WeakMap<PlayerSession, string>();
// Money in the bank, reported by runners that know it (shared-turn.ts).
const banked = new WeakMap<PlayerSession, number>();
export const noteBanked = (session: PlayerSession, gold: number) => banked.set(session, gold);
const kept = lasting('loops');

// Twenty minutes of nothing but its job after a loop.
export const forcedToWork = (session: PlayerSession) => (forced.get(session) ?? 0) > Date.now();

// Skills, money (carried and banked), everything carried and health: what changes when it gets
// anywhere.
function progress(session: PlayerSession): string {
  const skills = [...session.world.skills.values()].reduce((sum, skill) => sum + (skill.base ?? 0), 0);
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((item) => item.layer === Layer.Backpack);
  let goods = 0;
  const visit = (parent: number) => {
    for (const item of session.world.childrenOf(parent)) {
      goods += item.amount ?? 1;
      visit(item.serial);
    }
  };
  if (pack) visit(pack.serial);
  const gold = (session.world.status?.gold ?? 0) + (banked.get(session) ?? 0);
  // Health coming back counts: resting to fight again is part of the job.
  return `${Math.round(skills * 10)}:${gold}:${goods}:${session.world.status?.hits ?? 0}`;
}

// Numbers and coordinates do not make a step different.
const kindOf = (phase: string, note: string) => `${phase}: ${note.replace(/-?\d+/g, '#')}`.slice(0, 120);

function trigger(session: PlayerSession, watch: Watch, reason: string) {
  const now = Date.now();
  watch.steps = [];
  watch.progressAt = now;
  watch.jobAt = now;
  forced.set(session, now + FORCE_MS);
  pending.set(session, reason);
  const name = names.get(session) ?? 'resident';
  info(`[loop] ${name}: ${reason}`);
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
    progress: progress(session),
    progressAt: now,
    jobAt: now,
    at: session.world.position ?? { x: 0, y: 0 },
    checkedAt: now
  };
  watches.set(session, watch);
  return watch;
}

export function watchStep(session: PlayerSession, name: string, phase: string, note: string) {
  if (phase === 'setback' || phase === 'loop') return;
  names.set(session, name);
  const watch = watchOf(session);
  watch.phase = phase;
  if (!ERRANDS.test(phase)) watch.jobAt = Date.now();
  const current = progress(session);
  if (current !== watch.progress) {
    watch.progress = current;
    watch.progressAt = Date.now();
    watch.steps = [];
    return;
  }
  watch.steps = [...watch.steps.slice(-40), kindOf(phase, note)];
  const run = repeated(watch.steps);
  if (run) trigger(session, watch, `the same steps three times with nothing gained: ${run.join(' → ')}`);
}

// Raised from the runner's own check(), inside its ordinary error handling. Every few seconds it
// also looks at time: progress, and steps of its job (a job phase while it moves).
export function checkLoop(session: PlayerSession) {
  const now = Date.now();
  const watch = watchOf(session);
  if (now - watch.checkedAt >= 5000) {
    watch.checkedAt = now;
    const current = progress(session);
    if (current !== watch.progress) {
      watch.progress = current;
      watch.progressAt = now;
      watch.steps = [];
    }
    const at = session.world.position;
    if (at && Math.max(Math.abs(at.x - watch.at.x), Math.abs(at.y - watch.at.y)) >= 3) {
      watch.at = { x: at.x, y: at.y };
      if (!ERRANDS.test(watch.phase)) watch.jobAt = now;
    }
    if (BREAKS.test(watch.phase)) watch.jobAt = now;
    if (now - Math.max(watch.progressAt, watch.jobAt) > IDLE_MS)
      trigger(session, watch, `five minutes with nothing gained and no step of its job (${watch.phase || 'no phase'})`);
  }
  const loop = pending.get(session);
  if (!loop) return;
  pending.delete(session);
  throw new Stuck(`Going in circles (${loop})`);
}

// Time since this resident's skills, money or goods last changed (drives.ts).
export function sinceProgress(session: PlayerSession) {
  const watch = watches.get(session);
  return watch ? Date.now() - watch.progressAt : 0;
}
