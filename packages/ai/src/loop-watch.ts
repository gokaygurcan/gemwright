import { info } from './log';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';

// A loop is the same few steps over and over while nothing gets better: no skill gained, no gold
// or goods gained or spent. Players see that as a broken bot, so every runner reports its phases
// here; a loop raises `Stuck` from the runner's next check(), its setback handling does something
// else, and the same loop again waits longer each time (setback.ts escalates by reason).
const WINDOW_MS = 10 * 60_000;
const MIN_STEPS = 15;
const MAX_KINDS = 4;

export class Stuck extends Error {}

interface Step {
  at: number;
  kind: string;
}
interface Watch {
  steps: Step[];
  progress: string;
  since: number;
}
const watches = new WeakMap<PlayerSession, Watch>();
const pending = new WeakMap<PlayerSession, string>();

// Raised from the runner's own check(), inside its ordinary error handling.
export function checkLoop(session: PlayerSession) {
  const loop = pending.get(session);
  if (!loop) return;
  pending.delete(session);
  throw new Stuck(`Going in circles (${loop})`);
}

// What would change if the resident got anywhere: skills, carried gold and everything it carries
// (a bank deposit or a purchase changes the pack too).
function progress(session: PlayerSession): string {
  const skills = [...session.world.skills.values()].reduce((sum, skill) => sum + (skill.base ?? 0), 0);
  const self = session.world.serial ?? -1;
  const pack = session.world.childrenOf(self).find((item) => item.layer === Layer.Backpack)?.serial;
  let goods = 0;
  const seen = new Set<number>();
  const visit = (parent: number) => {
    for (const item of session.world.childrenOf(parent)) {
      if (seen.has(item.serial)) continue;
      seen.add(item.serial);
      goods += item.amount ?? 1;
      visit(item.serial);
    }
  };
  if (pack !== undefined) visit(pack);
  return `${Math.round(skills * 10)}:${session.world.status?.gold ?? 0}:${goods}`;
}

// Numbers and coordinates do not make a step different: "resting (3/34)" and "resting (5/34)"
// are the same step.
const kindOf = (phase: string, note: string) => `${phase}: ${note.replace(/-?\d+/g, '#')}`;

export function watchStep(session: PlayerSession, name: string, phase: string, note: string) {
  if (phase === 'setback' || phase === 'loop') return;
  const now = Date.now();
  const watch = watches.get(session) ?? { steps: [], progress: progress(session), since: now };
  watches.set(session, watch);
  const current = progress(session);
  if (current !== watch.progress) {
    watch.progress = current;
    watch.since = now;
    watch.steps = [];
  }
  watch.steps = [...watch.steps.filter((step) => now - step.at < WINDOW_MS), { at: now, kind: kindOf(phase, note) }];
  const kinds = [...new Set(watch.steps.map((step) => step.kind))];
  if (now - watch.since < WINDOW_MS || watch.steps.length < MIN_STEPS || kinds.length > MAX_KINDS) return;
  watch.steps = [];
  watch.since = now;
  // A stable message per loop, so repeats of the same loop are recognised and wait longer.
  const loop = kinds.sort().join(' / ').slice(0, 150);
  info(`[loop] ${name}: ${loop}`);
  pending.set(session, loop);
}
