import { HUMAN_ELF_BODIES } from '@gemwright/common/bodies';
import { gold } from '@gemwright/common/items';

import { groundOf } from './cemeteries';
import { type DecisionCoordinator, type DecisionPick, decisionGuard, decisionState } from './decisions';
import { encounterAdvice } from './experience';
import { bandage, type FighterContext, healPotion, huntable } from './fighter-context';
import { describe, engageable, prey, profileOf } from './fighter-prey';
import { warOpponent } from './guild-wars';
import { organizeParty, partyOf, partyTarget, setPartyTarget } from './hunting-party';
import { distance } from './navigation';
import { followPlan, leadPlan } from './party-talk';
import type { Entity } from './protocol/world';

export type HuntChoice =
  | { kind: 'fight'; opponent: Entity; pick: DecisionPick | null }
  | { kind: 'patrol'; pick: DecisionPick | null }
  | { kind: 'return'; pick: DecisionPick }
  | { kind: 'avoid'; until: number };

// Another player standing next to an undead is fighting it; a real player finds their own.
const claimedByOther = (ctx: FighterContext, mobile: Entity) =>
  ctx
    .nearby()
    .some(
      (other) =>
        other.serial !== ctx.serial &&
        !partyOf(ctx.serial)?.members.has(other.serial) &&
        HUMAN_ELF_BODIES.has(other.graphic) &&
        [1, 2].includes(other.notoriety ?? 0) &&
        other.position &&
        mobile.position &&
        distance(other.position, mobile.position) <= 2
    );

const crowded = (ctx: FighterContext, mobile: Entity) =>
  ctx
    .nearby()
    .filter(
      (other) =>
        prey.has(other.graphic) && other.position && distance(mobile.position ?? ctx.position(), other.position) < 4
    ).length > 2;

export async function chooseOpponent(
  ctx: FighterContext,
  options: { unreachable: Set<number>; decisions?: DecisionCoordinator; stopping?: () => boolean }
): Promise<HuntChoice> {
  const { session, checkpoint, template, trip, position, status, count, check } = ctx;
  // A guild at war fights the enemy's members met on the hunting grounds first (guild-wars.ts).
  const enemy = warOpponent(ctx);
  if (enemy && !options.unreachable.has(enemy.serial)) return { kind: 'fight', opponent: enemy, pick: null };
  await organizeParty(ctx, options.decisions);
  // A member answers the leader's announced plan and fights the agreed target on the call.
  const agreed = await followPlan(ctx, options.decisions);
  if (agreed && huntable(agreed, options.unreachable)) return { kind: 'fight', opponent: agreed, pick: null };
  const shared = partyTarget(ctx);
  if (shared && huntable(shared, options.unreachable) && engageable(ctx, shared).ok)
    return { kind: 'fight', opponent: shared, pick: null };
  const place = (item: Entity) => ({ map: session.world.map ?? 1, ...(item.position ?? position()) });
  const candidates = ctx
    .nearby()
    .filter((item) => huntable(item, options.unreachable))
    .sort((a, b) => distance(position(), a.position ?? position()) - distance(position(), b.position ?? position()));
  const eligible: Entity[] = [];
  const avoided: number[] = [];
  for (const item of candidates) {
    check();
    const learned = encounterAdvice(checkpoint, place(item), item.graphic);
    if (learned.avoidUntil > Date.now()) {
      avoided.push(learned.avoidUntil);
      continue;
    }
    try {
      await session.inspect(item.serial);
    } catch (error) {
      check();
      if (session.phase !== 'ready' || !(error instanceof Error) || !error.message.includes('observed character name'))
        throw error;
      // A candidate can die or leave view while its name request is in flight.
      continue;
    }
    const current = session.world.entities.get(item.serial);
    if (!current?.position) continue;
    if (!engageable(ctx, current).ok || crowded(ctx, current) || claimedByOther(ctx, current)) continue;
    eligible.push(current);
    if (eligible.length >= 3) break;
  }
  const score = (item: Entity) =>
    distance(position(), item.position ?? position()) +
    encounterAdvice(checkpoint, place(item), item.graphic).caution * 20;
  eligible.sort((a, b) => score(a) - score(b));
  if (!eligible.length && avoided.length) return { kind: 'avoid', until: Math.min(...avoided) };
  const baseline = eligible[0];
  // Ask the provider only when there is a real trade-off: an optional-tier target, or several
  // targets to compare. "Fight the one nearby zombie or patrol" stays a local rule.
  const meaningful = eligible.length >= 2 || eligible.some((item) => profileOf(item)?.tier !== 'common');
  // A leader with company talks the fight over before anyone attacks.
  const planned = await leadPlan(ctx, eligible, options.decisions);
  if (planned) return { kind: 'fight', opponent: planned, pick: null };
  if (baseline) setPartyTarget(ctx, baseline.serial);
  if (!options.decisions || !meaningful)
    return baseline ? { kind: 'fight', opponent: baseline, pick: null } : { kind: 'patrol', pick: null };
  const fightCandidates = eligible.map((item) => ({
    id: `fight-${item.serial}`,
    description: `Engage the observed ${describe(item)} at ${item.position?.x},${item.position?.y}; distance ${distance(position(), item.position ?? position())}.`,
    valid: () => {
      const current = session.world.entities.get(item.serial);
      return (
        !!current?.position &&
        prey.has(current.graphic) &&
        encounterAdvice(checkpoint, place(current), current.graphic).avoidUntil <= Date.now() &&
        engageable(ctx, current).ok &&
        [3, 4, 5, 6].includes(current.notoriety ?? 0) &&
        distance(position(), current.position) <= 16 &&
        status().hits >= status().maxHits * 0.7 &&
        !crowded(ctx, current) &&
        !claimedByOther(ctx, current)
      );
    }
  }));
  const pick = await options.decisions.choose({
    kind: 'hunting-opponent',
    checkpoint,
    observationRevision: session.world.revision,
    state: decisionState(session, template, checkpoint, {
      profession: template.archetype?.id ?? 'swordsman',
      area: `${groundOf(ctx.trip).name} cemetery`,
      killsSinceBank: trip.killsSinceBank,
      lootItems: trip.loot.length,
      bandages: count(bandage),
      healingPotions: count(healPotion),
      opponents: eligible.map((item) => ({
        serial: item.serial,
        name: describe(item),
        body: item.graphic,
        position: item.position,
        notoriety: item.notoriety,
        hits: item.hits,
        maxHits: item.maxHits
      })),
      note: 'Health bars are normalized. Weigh reward and skill gain against risk; casters hit hard with spells. Town trips take minutes, so return only for a real need.'
    }),
    candidates: [
      ...fightCandidates,
      {
        id: 'patrol',
        description: 'Look elsewhere inside the graveyard for a better suited opponent instead of these targets.',
        valid: () => true
      },
      {
        id: 'return-town',
        description: 'Return to Britain, sell and bank loot, restock and recover before another trip.',
        valid: () => trip.killsSinceBank > 0 || count(gold) > 250
      }
    ],
    baseline: baseline ? `fight-${baseline.serial}` : 'patrol',
    stillCurrent: decisionGuard(session, options.stopping)
  });
  check();
  if (!pick) return { kind: 'patrol', pick: null };
  if (pick.id === 'return-town') return { kind: 'return', pick };
  const opponent = eligible.find((item) => pick.id === `fight-${item.serial}`);
  return opponent ? { kind: 'fight', opponent, pick } : { kind: 'patrol', pick };
}
