import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';

import { chaosOf } from './chaos';
import { type DecisionPick, decisionGuard, decisionState, requireDecision } from './decisions';
import { driveBias } from './drives';
import { prefersHaven } from './haven';
import { packFull } from './inventory';
import type { LifeContext } from './life';
import { residentNeeds } from './needs';
import { goalPhaseBias } from './personal-goals';
import { shardProfile } from './shard-profile';
import { trainable } from './skill-training';
import { earnedGold, skillGrowth, workEvidence } from './work-evidence';
import { type LifePhase, world } from './world';

export const config = world.lifecycle ?? {
  mix: 'balanced',
  mixes: { balanced: { work: 40, dungeon: 15, errands: 10, leisure: 15, visit: 10, practice: 10 } },
  minutes: {
    work: [20, 45],
    dungeon: [20, 45],
    errands: [3, 10],
    leisure: [5, 15],
    visit: [15, 40],
    practice: [5, 15]
  },
  maxSwitchesPerMinute: 5
};
const mix = config.mixes[config.mix];
if (!mix) throw new Error(`Unknown lifecycle mix ${config.mix}`);
const phases = Object.keys(mix) as LifePhase[];
const describe: Record<LifePhase, string> = {
  work: 'Get on with my own work',
  dungeon: 'Go on a dungeon run, alone or with a party',
  errands: 'Run errands in town: bank, sell, restock',
  leisure: 'Spend some time at the bank or an inn among other people',
  visit: 'Travel to another town for a while, then come home',
  practice: 'Practise a supporting skill or rest somewhere safe'
};
const mean = ([low, high]: [number, number]) => (low + high) / 2;

// Picks from the time split: a phase's chance is its share of time over its mean length, so the
// time spent comes out at the configured shares.
// How far a resident's build has come: the mean base of its primary skills, 0 to 1.
export function skillProgress(ctx: Pick<LifeContext, 'session' | 'template'>): number {
  const primaries = ctx.template.archetype?.primarySkills ?? [];
  if (!primaries.length) return 0.5;
  const sum = primaries.reduce((n, name) => n + (ctx.session.world.skills.get(skillId(name))?.base ?? 0), 0);
  return Math.min(1, sum / primaries.length / 100);
}

// The skill curve: the lower the skills, the more the time goes to work and practice (where skills
// rise); the higher, the more to leisure and visits (long trips, nearly none early on). At progress
// p: work x(1 + 0.5(1-p)), practice x(1 + (1-p)), leisure x(0.3 + 0.7p), visit x p^2.
export function skillCurve(p: number): Partial<Record<LifePhase, number>> {
  return { work: 1 + 0.5 * (1 - p), practice: 2 - p, leisure: 0.3 + 0.7 * p, visit: p * p };
}

// Seasons of activity: evenings bring more leisure, visits and dungeon groups, late nights more
// quiet work and practice, weekends more dungeons. Only the weights shift; every phase stays
// possible, and work, selling and recovery are never held back.
function season(phase: LifePhase, now = new Date()) {
  // The shard's own clock (gemwright.json timezone): its evenings are its players' evenings.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: shardProfile().timezone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? now.getUTCHours());
  const weekend = ['Sat', 'Sun'].includes(parts.find((p) => p.type === 'weekday')?.value ?? '');
  const evening = hour >= 17 && hour < 23;
  const night = hour < 6;
  const social = phase === 'leisure' || phase === 'visit';
  let weight = 1;
  if (evening && (social || phase === 'dungeon')) weight *= 1.4;
  if (night && (phase === 'work' || phase === 'practice')) weight *= 1.3;
  if (night && social) weight *= 0.7;
  if (weekend && phase === 'dungeon') weight *= 1.5;
  return weight;
}

// A need the resident cannot bluster through decides the phase before any weighting: an empty
// purse, a missing tool or a pack full of unsold goods is not a preference. Without these gates the
// weights below could happily roll leisure on a broke resident with a broken pickaxe. Everything
// else — skill curve, season, learned drives, temperament — still decides as it did.
export function needPhase(ctx: LifeContext, valid: LifePhase[]): LifePhase | undefined {
  const want = (phase: LifePhase) => (valid.includes(phase) ? phase : undefined);
  const needs = residentNeeds(ctx.session, ctx.checkpoint, ctx.template);
  if (needs.some((need) => need.kind === 'tool' || need.kind === 'supply')) return want('errands');
  const serial = ctx.session.world.serial;
  const pack =
    serial === null || serial === undefined
      ? undefined
      : ctx.session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
  if (pack && packFull(ctx.session, pack.serial, 0.85)) return want('errands');
  if (needs.some((need) => need.kind === 'income')) return want('work');
  return undefined;
}

function localPick(ctx: LifeContext, valid: LifePhase[]): LifePhase {
  const need = needPhase(ctx, valid);
  if (need) return need;
  const { sociability, riskTolerance } = ctx.template.behavior;
  const curve = skillCurve(skillProgress(ctx));
  // Traits (temperament.ts): a homebody seldom visits other towns; a restless one goes out more.
  const { homebody = 1, restlessness = 1 } = ctx.template.behavior.temperament ?? {};
  const shade: Partial<Record<LifePhase, number>> = {
    work: curve.work,
    practice: curve.practice,
    leisure: (0.5 + sociability) * (curve.leisure ?? 1),
    visit: ((0.5 + sociability) * (curve.visit ?? 1) * restlessness) / homebody,
    dungeon: 0.5 + riskTolerance
  };
  const weights = valid.map(
    (p) =>
      ((mix?.[p] ?? 0) / mean(config.minutes[p])) *
      (shade[p] ?? 1) *
      goalPhaseBias(ctx, p) *
      season(p) *
      driveBias(ctx, p)
  );
  let roll = Math.random() * weights.reduce((sum, w) => sum + w, 0);
  for (const [i, p] of valid.entries()) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return p;
  }
  return 'work';
}

export async function chooseLifePhase(ctx: LifeContext): Promise<{ phase: LifePhase; pick: DecisionPick | null }> {
  // Practice only while a supporting skill can still rise (skill-training.ts): maxed ones are done.
  // A Young resident of New Haven stays out of dungeons until it outgrows Young (haven.ts); visiting
  // other towns is its own choice.
  const young = prefersHaven(ctx.session);
  const valid = phases.filter((p) =>
    young && p === 'dungeon'
      ? false
      : p === 'dungeon'
        ? !!ctx.dungeon && !!ctx.dungeonReady?.()
        : p === 'practice'
          ? trainable(ctx.session, ctx.template.archetype).length > 0
          : true
  );
  let baseline = localPick(ctx, valid);
  // A change of plans (chaos.ts): a planned visit or leisure sometimes becomes something else.
  if (['visit', 'leisure'].includes(baseline) && Math.random() < chaosOf(ctx.session) / 3) {
    const instead = localPick(
      ctx,
      valid.filter((p) => p !== baseline)
    );
    ctx.log(`Changed my mind: ${instead} instead of ${baseline}`);
    baseline = instead;
  }
  if (!ctx.decisions) return { phase: baseline, pick: null };
  const pick = await ctx.decisions.choose({
    kind: 'life-phase',
    checkpoint: ctx.checkpoint,
    observationRevision: ctx.session.world.revision,
    state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
      previous: ctx.checkpoint.life?.phase ?? 'none',
      timeSplit: mix,
      // How far the build has come (0-1): low means train, high means enjoy (skillCurve).
      skillProgress: Number(skillProgress(ctx).toFixed(2)),
      home: ctx.city
    }),
    candidates: valid.map((p) => ({ id: p, description: describe[p], valid: () => true })),
    baseline,
    stillCurrent: decisionGuard(ctx.session)
  });
  requireDecision(pick);
  const chosen = (valid.find((p) => p === pick?.id) ?? baseline) as LifePhase;
  return { phase: chosen, pick };
}

export function finishLifeDecision(
  ctx: Pick<LifeContext, 'checkpoint' | 'decisions'>,
  status: 'completed' | 'failed' | 'interrupted',
  note: string
) {
  const life = ctx.checkpoint.life;
  if (!life?.decision) return;
  ctx.decisions?.finish(ctx.checkpoint, life.decision, status, note);
  delete life.decision;
}

export function observeLifeWork(ctx: LifeContext) {
  const life = ctx.checkpoint.life;
  if (life?.phase !== 'work' || !life.decision || !life.before) return;
  const after = workEvidence(ctx.session, ctx.checkpoint);
  if (
    earnedGold(life.before, after) > 0 ||
    skillGrowth(life.before, after) > 0 ||
    after.products > life.before.products ||
    after.orders > life.before.orders
  )
    finishLifeDecision(ctx, 'completed', 'Observed work increase funds, base skills, production or fulfilled orders');
}
