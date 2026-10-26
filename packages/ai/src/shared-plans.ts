import { canPause, checkedDelay } from './action-purpose';
import { cemeteries } from './cemeteries';
import type { LifeContext } from './life';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { JournalEntry } from './protocol/world';
import { residentCombat, residentContext } from './resident-context';
import { rememberPartner } from './resident-memory';
import type { Commitment } from './resident-memory-types';

export const asksSharedPlan = (text: string) =>
  /\b(?:clear|hunt)\b.*\b(?:cemetery|graveyard)\b.*\b(?:sell|restock)\b/i.test(text);
export function nearbyPlanGround(session: PlayerSession) {
  const here = session.world.position;
  if (!here) return undefined;
  const ground = [...cemeteries].sort((a, b) => distance(here, a.center) - distance(here, b.center))[0];
  return ground && distance(here, ground.center) <= 100 ? ground : undefined;
}
export function attachSharedPlan(session: PlayerSession, text: string): string | undefined {
  if (!asksSharedPlan(text)) return undefined;
  const ctx = residentContext(session),
    here = session.world.position;
  const commitment = ctx?.checkpoint.personal?.commitment;
  if (!ctx || !here || !commitment || commitment.kind !== 'hunt') return undefined;
  const ground = nearbyPlanGround(session);
  if (!ground) return 'Let us make that plan when we are near a cemetery I know.';
  commitment.plan = {
    stage: 'prepare',
    ground: { ...ground.center },
    groundName: ground.name,
    meeting: { x: here.x, y: here.y },
    startedAt: Date.now(),
    killsAtStart: commitment.kills,
    returnStep: /\b(?:come|return|back)\b/i.test(text)
  };
  commitment.until = Date.now() + 20 * 60_000;
  ctx.persist?.();
  return `Agreed: prepare, hunt at ${ground.name} cemetery for a short round, split collected gold, sell and restock${commitment.plan.returnStep ? ', then return here' : ''}. We leave early if it becomes unsafe.`;
}

// Only the agreed companion may alter this plan. Listen during combat without a conversational stop.
export function hearPlanControl(session: PlayerSession, entry: JournalEntry): boolean {
  const ctx = residentContext(session),
    commitment = ctx?.checkpoint.personal?.commitment;
  const plan = commitment?.plan;
  if (
    !ctx ||
    !commitment ||
    !plan ||
    entry.serial !== commitment.partner ||
    !['active', 'paused'].includes(commitment.state) ||
    !entry.text ||
    Date.now() - Date.parse(entry.at) > 8000
  )
    return false;
  const partner = session.world.entities.get(entry.serial);
  if (
    !entry.party &&
    (!partner?.position || !session.world.position || distance(partner.position, session.world.position) > 12)
  )
    return false;
  if (entry.party && !session.world.partyMembers.has(entry.serial)) return false;
  if (/\b(?:we(?:['’]re| are) leaving|retreat|fall back|head back|let['’]?s leave)\b/i.test(entry.text)) {
    plan.stage = 'settle';
    plan.stageAt = Date.now();
    plan.heldUntil = undefined;
  } else if (/\b(?:wait here|hold here|hold position)\b/i.test(entry.text)) plan.heldUntil = Date.now() + 60_000;
  else if (/\b(?:let['’]?s go|carry on|resume|continue)\b/i.test(entry.text)) plan.heldUntil = undefined;
  else if (/\b(?:leave that one|skip that one|do not attack|don['’]?t attack)\b/i.test(entry.text)) {
    const target = session.world.combatant ?? residentContext(session)?.checkpoint.hunting?.encounter?.opponent;
    if (target) plan.ignore = { serial: target, until: Date.now() + 60_000 };
  } else return false;
  ctx.persist?.();
  return true;
}

export function planStopsFight(session: PlayerSession, opponent: number): boolean {
  const plan = residentContext(session)?.checkpoint.personal?.commitment?.plan;
  return (
    !!plan &&
    (plan.stage !== 'hunt' ||
      (plan.heldUntil ?? 0) > Date.now() ||
      (plan.ignore?.serial === opponent && plan.ignore.until > Date.now()))
  );
}

export async function sharedPlanTurn(ctx: LifeContext, commitment: Commitment): Promise<boolean> {
  const plan = commitment.plan;
  if (!plan) return false;
  const fight = residentCombat(ctx.session);
  if (!fight || (ctx.session.world.status && ctx.session.world.status.hits < ctx.session.world.status.maxHits * 0.5))
    return false;
  if ((plan.heldUntil ?? 0) > Date.now()) {
    await checkedDelay(500, ctx.check);
    return true;
  }
  const advance = (stage: typeof plan.stage) => {
    plan.stage = stage;
    plan.stageAt = Date.now();
    ctx.persist();
  };
  if (plan.stage === 'prepare') {
    const status = ctx.session.world.status;
    if (!status || status.hits < status.maxHits * 0.85) return false;
    if (fight.ready && !fight.ready()) {
      commitment.state = 'cancelled';
      commitment.reason = 'Not enough supplies for the agreed hunt';
      ctx.session.say('I need to recover or restock before we can start that round.');
      ctx.persist();
      return false;
    }
    advance('hunt');
    return true;
  }
  if (plan.stage === 'hunt') {
    if (fight.ready && !fight.ready()) {
      advance('settle');
      return true;
    }
    const partner = ctx.session.world.entities.get(commitment.partner);
    if (!partner?.position || distance(partner.position, plan.ground) > 80) return false;
    if (distance(ctx.position(), plan.ground) > 35) {
      await ctx.navigate(plan.ground, 15);
      return true;
    }
    if (commitment.kills - plan.killsAtStart >= 3 || Date.now() - plan.startedAt > 5 * 60_000) {
      advance('settle');
      return true;
    }
    // Existing commitment combat chooses only opponents actually involving the companion.
    return false;
  }
  if (plan.stage === 'settle' || plan.stage === 'restock') {
    if (commitment.lootDue > 0) {
      const partner = ctx.session.world.entities.get(commitment.partner);
      if (
        partner?.position &&
        distance(ctx.position(), partner.position) > 2 &&
        distance(ctx.position(), partner.position) <= 20
      )
        await ctx.navigate(partner.position, 2);
      if (Date.now() - (plan.stageAt ?? plan.startedAt) < 30_000) {
        await checkedDelay(500, ctx.check);
        return true;
      }
      // Preserve the debt, but do not strand everyone indefinitely waiting for acceptance.
    }
    if (!canPause(ctx.session)) return false;
    ctx.phase('shared-plan-errands', 'Keeping the agreed plan: selling, banking and restocking');
    advance('restock');
    if (!ctx.errands) {
      commitment.state = 'paused';
      return false;
    }
    await ctx.errands();
    advance(plan.returnStep ? 'return' : 'complete');
    return true;
  }
  if (plan.stage === 'return') {
    await ctx.navigate(plan.meeting, 3);
    advance('complete');
    return true;
  }
  commitment.state = 'completed';
  rememberPartner(ctx.checkpoint, {
    partner: commitment.partner,
    name: commitment.name,
    kind: 'plan',
    result: 'completed',
    detail: `Finished our ${plan.groundName} cemetery round and town errands`,
    id: `${commitment.id}:plan-complete`
  });
  if (canPause(ctx.session))
    ctx.session.say('That was our round. I have finished my town errands; thanks for coming along.');
  ctx.persist();
  return true;
}
