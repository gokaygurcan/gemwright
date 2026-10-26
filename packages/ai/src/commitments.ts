import { gold } from '@gemwright/common/items';

import { canPause, checkedDelay } from './action-purpose';
import { unsafeCheck } from './danger';
import { endEngagement } from './engagement';
import { groupMember } from './group-awareness';
import type { LifeContext } from './life';
import { serviceLocations } from './locations';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { residentCombat, residentContext } from './resident-context';
import { personalMemory, rememberPartner } from './resident-memory';
import type { Commitment } from './resident-memory-types';
import { asksSharedPlan, attachSharedPlan, nearbyPlanGround, sharedPlanTurn } from './shared-plans';
import { sellByTrade } from './trade-deal';

export function commitmentConversation(
  session: PlayerSession,
  partner: number,
  name: string,
  text: string
): string | undefined {
  const ctx = residentContext(session),
    here = session.world.position;
  if (!ctx || !here || session.world.map === null) return undefined;
  const memory = personalMemory(ctx.checkpoint);
  const current = memory.commitment;
  if (asksSharedPlan(text) && !nearbyPlanGround(session))
    return 'Let us make that plan when we are near a cemetery I know.';
  if (
    current?.partner === partner &&
    /\b(?:stop following|leave me|go home|hunt is over|thanks.*enough)\b/i.test(text)
  ) {
    current.state = 'completed';
    current.reason = 'Partner ended the outing';
    ctx.persist?.();
    return 'All right. Thanks for the company.';
  }
  if (asksSharedPlan(text) && current?.partner === partner && ['active', 'paused'].includes(current.state))
    return attachSharedPlan(session, text);
  let kind: Commitment['kind'] | undefined;
  if (asksSharedPlan(text) || /\b(?:hunt together|come hunt|join me|hunt with me|come fighting)\b/i.test(text))
    kind = 'hunt';
  else if (/\b(?:follow me|come with me|come along)\b/i.test(text)) kind = 'follow';
  else if (/\b(?:take|show|lead|escort) me (?:to )?(?:the )?(?:bank|healer|smith)\b/i.test(text)) kind = 'escort';
  if (!kind) return undefined;
  const person = memory.partners[partner];
  if (!groupMember(session, partner) && (person?.conversations ?? 0) < 2 && (person?.trust ?? 0) < 0.1)
    return 'Maybe. Where are you heading, and what do you need a hand with?';
  if (current && (['active', 'paused'].includes(current.state) || current.lootDue > 0))
    return current.partner === partner
      ? 'I am still keeping our plan. Let us finish that first.'
      : 'I have already made plans with someone.';
  if (memory.orders.some((order) => ['accepted', 'ready'].includes(order.state)))
    return 'I need to finish an order before heading out.';
  if ((ctx.template.behavior.cooperation ?? 0.5) < 0.25 && (person?.trust ?? 0) < 0.3)
    return 'Thanks, but I would rather keep to my own plans today.';
  const status = session.world.status;
  if (!canPause(session) || !status || status.hits < status.maxHits * 0.8)
    return 'I need to recover before heading out with you.';
  if (kind === 'hunt' && !residentCombat(session)) return 'I am not equipped for a hunt, but I can help with supplies.';
  let destination: Commitment['destination'];
  if (kind === 'escort') {
    const service = /healer/i.test(text) ? 'healer' : /smith/i.test(text) ? 'blacksmith' : 'banker';
    destination = [...serviceLocations(ctx.city, service)].sort((a, b) => distance(here, a) - distance(here, b))[0];
    if (!destination || distance(here, destination) > 200) return 'I cannot safely guide you there from here.';
  }
  memory.commitment = {
    id: `outing:${partner}:${Date.now()}`,
    kind,
    partner,
    name,
    map: session.world.map,
    acceptedAt: Date.now(),
    until: Date.now() + 10 * 60_000,
    lastSeen: Date.now(),
    state: 'active',
    kills: 0,
    lootDue: 0,
    destination
  };
  if (kind === 'hunt' && !session.world.partyMembers.has(partner)) session.party('add', partner);
  const planReply = attachSharedPlan(session, text);
  endEngagement(session);
  ctx.persist?.();
  return (
    planReply ??
    (kind === 'hunt'
      ? 'Yes, let us hunt nearby for a little while. I need to return if my supplies run low; we can split any gold I collect.'
      : kind === 'escort'
        ? 'Sure. Stay close; I can show you the way.'
        : 'All right, I can come along for a few minutes. Where are we going?')
  );
}

function endOuting(ctx: LifeContext, commitment: Commitment, reason: string, completed: boolean) {
  commitment.state = completed ? 'completed' : 'cancelled';
  commitment.reason = reason;
  const partner = ctx.session.world.entities.get(commitment.partner);
  if (canPause(ctx.session) && partner?.position && distance(ctx.position(), partner.position) <= 8)
    ctx.session.say(reason);
  rememberPartner(ctx.checkpoint, {
    partner: commitment.partner,
    name: commitment.name,
    kind: completed ? 'outing' : 'commitment-ended',
    result: completed ? 'completed' : 'interrupted',
    detail: reason,
    id: `${commitment.id}:ended`
  });
  ctx.persist();
}

export async function commitmentTurn(ctx: LifeContext): Promise<boolean> {
  const { session } = ctx;
  const commitment = personalMemory(ctx.checkpoint).commitment;
  if (!commitment) return false;
  const partner = session.world.entities.get(commitment.partner);
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((item) => item.layer === Layer.Backpack);
  const coins = () =>
    pack
      ? session.world
          .childrenOf(pack.serial)
          .filter((item) => item.graphic === gold)
          .reduce((n, item) => n + (item.amount ?? 1), 0)
      : 0;
  if (
    commitment.lootDue > 0 &&
    Date.now() >= (commitment.shareRetryAt ?? 0) &&
    pack &&
    partner?.position &&
    distance(ctx.position(), partner.position) <= 2 &&
    canPause(session) &&
    coins() >= commitment.lootDue
  ) {
    commitment.shareRetryAt = Date.now() + 60_000;
    if (
      await sellByTrade(
        session,
        pack.serial,
        commitment.partner,
        (item) => item.graphic === gold,
        commitment.lootDue,
        0
      )
    ) {
      commitment.lootDue = 0;
      ctx.persist();
    }
  }
  if (!['active', 'paused'].includes(commitment.state)) return false;
  if (Date.now() > commitment.until) {
    endOuting(
      ctx,
      commitment,
      'I need to get back to my own plans now. Thanks for coming along.',
      !commitment.plan || commitment.plan.stage === 'complete'
    );
    return false;
  }
  if (session.world.map !== commitment.map) {
    endOuting(ctx, commitment, 'We lost each other at the crossing; I am heading back.', false);
    return false;
  }
  if (commitment.plan && !['prepare', 'hunt'].includes(commitment.plan.stage) && canPause(session))
    return sharedPlanTurn(ctx, commitment);
  if (!partner?.position) {
    if (Date.now() - commitment.lastSeen > 30_000) {
      endOuting(ctx, commitment, 'I lost sight of my companion and could not continue.', false);
      return false;
    }
    await checkedDelay(1000, ctx.check);
    return true;
  }
  commitment.lastSeen = Date.now();
  if (!canPause(session)) {
    commitment.state = 'paused';
    ctx.persist();
    return false;
  }
  const status = session.world.status;
  if (!status || status.hits < status.maxHits * 0.65 || status.weight >= status.maxWeight * 0.9) {
    endOuting(ctx, commitment, 'I need to recover or unload before I can continue.', false);
    return false;
  }
  commitment.state = 'active';
  if (await sharedPlanTurn(ctx, commitment)) return true;
  endEngagement(session);
  const fight = residentCombat(session);
  if (commitment.kind === 'hunt' && fight && (!commitment.plan || commitment.plan.stage === 'hunt')) {
    const candidates = [...session.world.swings].filter(
      ([attacker, swing]) =>
        Date.now() - swing.at < 5000 && (attacker === commitment.partner || swing.target === commitment.partner)
    );
    for (const [attacker, swing] of candidates) {
      const target = session.world.entities.get(attacker === commitment.partner ? swing.target : attacker);
      if (
        !target?.position ||
        session.world.deaths.has(target.serial) ||
        !fight.canFight(target) ||
        (commitment.plan?.ignore?.serial === target.serial && commitment.plan.ignore.until > Date.now())
      )
        continue;
      const before = coins();
      ctx.phase('hunting-together', `Hunting with ${commitment.name}`);
      await fight.fight(target);
      if (session.world.deaths.has(target.serial)) {
        commitment.kills++;
        commitment.lootDue += Math.floor(Math.max(0, coins() - before) / 2);
        rememberPartner(ctx.checkpoint, {
          partner: commitment.partner,
          name: commitment.name,
          kind: 'outing',
          result: 'completed',
          detail: 'Defeated an observed opponent together',
          id: `${commitment.id}:kill:${target.serial}`
        });
      }
      ctx.persist();
      return true;
    }
  }
  const destination = commitment.kind === 'escort' ? commitment.destination : partner.position;
  if (!destination || distance(ctx.position(), destination) > 80) {
    endOuting(ctx, commitment, 'You are too far ahead; I cannot keep up safely.', false);
    return false;
  }
  if (!fight && unsafeCheck(session)(destination)) {
    endOuting(ctx, commitment, 'That way looks dangerous. I need to stay back.', false);
    return false;
  }
  if (distance(ctx.position(), destination) > 3) {
    ctx.phase(
      commitment.kind === 'escort' ? 'escorting' : 'following-companion',
      `Keeping company with ${commitment.name}`
    );
    await ctx.navigate(destination, 3);
  } else if (commitment.kind === 'escort') {
    if (distance(ctx.position(), partner.position) <= 8) {
      endOuting(ctx, commitment, 'Here we are. This is the place you asked for.', true);
      return true;
    }
  }
  ctx.persist();
  await checkedDelay(1000, ctx.check);
  return true;
}
