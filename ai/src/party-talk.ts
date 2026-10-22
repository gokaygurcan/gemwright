import type { DecisionCoordinator } from './decisions';
import { decisionState } from './decisions';
import { bandage, type FighterContext, weaponSkill } from './fighter-context';
import { profileOf } from './fighter-prey';
import { alliesNear, partyOf, roleOf } from './hunting-party';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

// A party talks its fight over in ordinary speech before acting: the leader proposes a target and
// roles, members answer (ready, or not yet), and the leader calls the attack. The registry carries
// the agreed plan; the speech is what other players see. Jev (when configured) picks the target
// among verified candidates; otherwise the local rule prefers the strongest creature the party
// can take, then the nearest.
const WAIT = 15_000;
const compass = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ns = dy < -3 ? 'north' : dy > 3 ? 'south' : '';
  const ew = dx > 3 ? 'east' : dx < -3 ? 'west' : '';
  return ns || ew ? `to the ${ns}${ns && ew ? '-' : ''}${ew}` : 'right here';
};
const first = (name?: string) => (name ?? 'friend').split(' ')[0];
const ready = (ctx: FighterContext) => ctx.status().hits >= ctx.status().maxHits * 0.7 && ctx.count(bandage) >= 5;
const rank = (mobile: Entity) => ['common', 'brute', 'caster', 'knight'].indexOf(profileOf(mobile)?.tier ?? 'common');

const say = (ctx: FighterContext, line: string) => {
  try {
    ctx.session.say(line);
  } catch {
    // Speech is flavour; the plan still stands without it.
  }
};
const hold = async (ctx: FighterContext, until: number, done: () => boolean) => {
  while (Date.now() < until && !done()) {
    ctx.check();
    await Bun.sleep(1000);
  }
};

// Leader: proposes a target among `eligible`, waits for answers, calls the attack. Returns the
// agreed target, or undefined to carry on alone this round.
export async function leadPlan(ctx: FighterContext, eligible: Entity[], decisions?: DecisionCoordinator) {
  const party = partyOf(ctx.serial);
  const together = alliesNear(ctx, ctx.position());
  if (!party || party.leader !== ctx.serial || !together.length || !eligible.length) return undefined;
  // Talk it over for a creature worth coordinating, or now and then; plain zombies need no meeting.
  const worth = eligible.some((mobile) => rank(mobile) > 0);
  if (!worth && Date.now() - (party.plan?.at ?? 0) < 120_000) return undefined;
  const baseline = [...eligible].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      distance(ctx.position(), a.position ?? ctx.position()) - distance(ctx.position(), b.position ?? ctx.position())
  )[0];
  if (!baseline) return undefined;
  let chosen = baseline;
  if (decisions) {
    const pick = await decisions.choose({
      kind: 'party-plan',
      checkpoint: ctx.checkpoint,
      observationRevision: ctx.session.world.revision,
      state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
        party: together.length + 1,
        candidates: eligible.length
      }),
      candidates: eligible.slice(0, 6).map((mobile) => ({
        id: `party-${mobile.serial}`,
        description: `Lead ${together.length + 1} fighters against ${mobile.name ?? 'an undead'} (${profileOf(mobile)?.note ?? 'undead'}) ${compass(ctx.position(), mobile.position ?? ctx.position())}.`,
        valid: () => !!ctx.session.world.entities.get(mobile.serial)?.position
      })),
      baseline: `party-${baseline.serial}`,
      stillCurrent: () => !!ctx.session.world.entities.get(baseline.serial)
    });
    chosen = eligible.find((mobile) => pick && `party-${mobile.serial}` === pick.id) ?? baseline;
  }
  const roles = together
    .map((ally) => {
      const archer = roleOf(ally.serial) === 'Archery';
      return `${first(ally.name)}, ${archer ? 'keep your bow on it' : 'take a flank'}`;
    })
    .join('; ');
  party.plan = {
    target: chosen.serial,
    at: Date.now(),
    answered: new Set([ctx.serial]),
    ready: new Set([ctx.serial]),
    out: new Set()
  };
  party.target = chosen.serial;
  const opening = weaponSkill(ctx.template) === 'Archery' ? 'I will shoot from the back' : 'I will take the front';
  say(
    ctx,
    `${chosen.name ?? 'Undead'} ${compass(ctx.position(), chosen.position ?? ctx.position())}. ${opening}; ${roles}. Ready?`
  );
  const plan = party.plan;
  await hold(ctx, Date.now() + WAIT, () => [...party.members].every((m) => plan.answered.has(m)));
  const settled = (m: number) => plan.ready.has(m) || plan.out.has(m);
  if (![...party.members].every(settled)) {
    say(ctx, 'We wait a moment for everyone.');
    await hold(ctx, Date.now() + WAIT, () => [...party.members].every(settled));
  }
  plan.go = Date.now();
  say(ctx, 'Now! Together!');
  return ctx.session.world.entities.get(chosen.serial);
}

// Member: answers the leader's plan in speech, then waits for the call. Jev (when configured) picks
// the answer; the local rule joins when healthy and bandaged, otherwise recovers briefly first.
// Returns the agreed target once the leader calls go, or undefined when sitting the fight out.
export async function followPlan(ctx: FighterContext, decisions?: DecisionCoordinator) {
  const party = partyOf(ctx.serial);
  const plan = party?.plan;
  if (!party || !plan || party.leader === ctx.serial || Date.now() - plan.at > WAIT * 3) return undefined;
  if (!plan.answered.has(ctx.serial)) {
    plan.answered.add(ctx.serial);
    const target = ctx.session.world.entities.get(plan.target);
    const what = target?.name ?? 'the undead';
    const baseline = ready(ctx) ? 'join-now' : 'recover-first';
    const pick = decisions
      ? await decisions.choose({
          kind: 'party-answer',
          checkpoint: ctx.checkpoint,
          observationRevision: ctx.session.world.revision,
          state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
            party: party.members.size,
            target: what,
            targetNote: target ? (profileOf(target)?.note ?? 'undead') : 'not visible',
            bandages: ctx.count(bandage)
          }),
          candidates: [
            { id: 'join-now', description: `Answer ready and fight ${what} on the call.`, valid: () => true },
            {
              id: 'recover-first',
              description: 'Ask the party to wait up to ten seconds while bandaging, then join.',
              valid: () => ctx.count(bandage) > 0
            },
            {
              id: 'sit-out',
              description: `Sit this fight out and stay in the party; the others take ${what} without you.`,
              valid: () => true
            }
          ],
          baseline,
          stillCurrent: () => party.plan === plan
        })
      : null;
    const answer = pick?.id ?? baseline;
    if (answer === 'sit-out') {
      plan.out.add(ctx.serial);
      say(ctx, 'I will sit this one out.');
      decisions?.finish(ctx.checkpoint, pick, 'completed', 'Sat the fight out');
      return undefined;
    }
    if (answer === 'join-now')
      say(ctx, weaponSkill(ctx.template) === 'Archery' ? 'Bow is ready.' : 'Right behind you.');
    else {
      say(ctx, 'Hold on, I need to bandage first.');
      await hold(ctx, Date.now() + 10_000, () => ready(ctx));
      say(ctx, 'Ready now.');
    }
    plan.ready.add(ctx.serial);
    decisions?.finish(ctx.checkpoint, pick, 'completed', `Answered ${answer}`);
  }
  if (plan.out.has(ctx.serial)) return undefined;
  await hold(ctx, plan.at + WAIT * 3, () => plan.go !== undefined);
  const target = ctx.session.world.entities.get(plan.target);
  return plan.go !== undefined && target?.position ? target : undefined;
}
