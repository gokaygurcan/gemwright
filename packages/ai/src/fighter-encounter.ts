import { randomUUID } from 'node:crypto';

import { urgentAction } from './action-purpose';
import { Blocked } from './blocked';
import { nearAnyGround } from './cemeteries';
import { combatPosition } from './combat-position';
import { type DecisionCoordinator, type DecisionPick, decisionState } from './decisions';
import { encounterTarget } from './encounter-target';
import { rememberExperience } from './experience';
import type { createFighterCombat } from './fighter-combat';
import {
  bandage,
  Died,
  type FighterContext,
  healPotion,
  observedThreat,
  Retreat,
  weaponSkill
} from './fighter-context';
import { poisonWeapon } from './fighter-poison';
import { engageable } from './fighter-prey';
import { visibleAllies } from './group-awareness';
import { castTurn } from './mage-combat';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';
import { equippedRanged, rangedGraphics, rangedWeapon, shootingWindow } from './ranged-weapons';
import { planStopsFight } from './shared-plans';
import { learnWork } from './strategy-learning';

async function fightEncounter(
  ctx: FighterContext,
  combat: ReturnType<typeof createFighterCombat>,
  opponent: Entity,
  decisions?: DecisionCoordinator,
  stopping?: () => boolean
) {
  const {
    session,
    template,
    checkpoint,
    trip,
    state,
    stats,
    status,
    position,
    check,
    phase,
    navigate,
    log,
    dead,
    count
  } = ctx;
  const { combatAssessment, bandageBreak, heal } = combat;
  let tacticalDecision: DecisionPick | null = null;
  let startedAt = Date.now();
  let memoryId = randomUUID();
  let encounterPlace = { map: session.world.map ?? 1, ...position() };
  let initialHealth = status().hits / Math.max(1, status().maxHits);
  const recordOutcome = (outcome: 'victory' | 'retreat' | 'death' | 'interrupted') => {
    const changes = session.world.healthChanges.filter((change) => change.at >= startedAt);
    rememberExperience(checkpoint, {
      kind: 'combat',
      id: memoryId,
      at: Date.now(),
      ...encounterPlace,
      body: opponent.graphic,
      outcome,
      largestLossRatio: Math.max(0, ...changes.map((change) => change.damage / Math.max(1, change.maxHits))),
      lowestHealthRatio: Math.min(initialHealth, ...changes.map((change) => change.hits / Math.max(1, change.maxHits))),
      damageRatio: changes.reduce((sum, change) => sum + change.damage / Math.max(1, change.maxHits), 0)
    });
    ctx.persist();
  };
  try {
    trip.encounter = {
      opponent: opponent.serial,
      startedAt: new Date(startedAt).toISOString(),
      position: { ...position() },
      body: opponent.graphic,
      memoryId
    };
    phase('fighting', `Engaging ${opponent.name ?? 'undead'} (${opponent.serial})`);
    state.inCombat = true;
    state.fightingSerial = opponent.serial;
    // Attack requests outside line of sight are silently refused by ServUO.
    // Approach first, then require the combat-target response before chasing.
    // Archers shoot from range (bows reach 10; BaseRanged fires only after standing still briefly).
    // Archers with no arrows or bolts fight bare-handed (Wrestling) instead of walking away, as a
    // player would; the bow goes back on once there is ammunition for it.
    const bowman = weaponSkill(ctx.template) === 'Archery';
    const carriedBow = ctx
      .contents()
      .find((item) => rangedGraphics.has(item.graphic) && count(rangedWeapon(item.graphic)?.ammo ?? ARROW) > 0);
    if (bowman && !equippedRanged(session) && carriedBow)
      await session.equipItem(carriedBow.serial, Layer.TwoHanded).catch(() => {});
    const held = equippedRanged(session);
    const brawling = bowman && (!held || count(rangedWeapon(held.graphic)?.ammo ?? ARROW) === 0);
    if (brawling && held) await session.moveItem(held.serial, ctx.backpack()).catch(() => {});
    const archer = bowman && !brawling;
    // Primary casters fight from range and cast offensively; Magery as a support skill only heals.
    const caster = !!ctx.template.archetype?.primarySkills.includes('Magery');
    const mage = caster || !!ctx.template.archetype?.supportingSkills.includes('Magery');
    const ranged = brawling ? undefined : rangedWeapon(equippedRanged(session)?.graphic);
    if (archer && !ranged) throw new Retreat('No supported ranged weapon is equipped');
    const maxRange = ranged?.range ?? (caster ? 10 : 1);
    const reach = archer || caster ? Math.max(4, maxRange - 2) : 1;
    let shootUntil = 0;
    const shootingPause = () => {
      if (ranged) shootUntil = Date.now() + shootingWindow(ranged, status().stamina);
    };
    const engage = async () => {
      const target = session.world.entities.get(opponent.serial);
      if (!target?.position) throw new Retreat('Opponent is no longer visible');
      await navigate(target.position, reach);
      try {
        await session.attack(opponent.serial);
      } catch {
        check();
        // Out of sight from range: close in once before giving up on the target.
        if (!archer && !caster) throw new Retreat('Server did not accept the melee target after approaching');
        await navigate(target.position, 2);
        await session.attack(opponent.serial).catch(() => {
          throw new Retreat('Server did not accept the ranged target after approaching');
        });
      }
    };
    const reposition = async (target: Entity) => {
      const threats = ctx
        .nearby()
        .filter((mobile) => mobile.serial !== target.serial && observedThreat(mobile, session.world.combatant));
      const spot = await combatPosition({
        session,
        terrain: ctx.terrain,
        origin: position(),
        target,
        threats,
        range: maxRange - 1,
        check
      });
      if (!spot) throw new Retreat('No safe reachable firing position away from nearby threats');
      try {
        await navigate(spot, 0);
        shootingPause();
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        throw new Retreat('Firing position was blocked by server movement feedback');
      }
    };
    await poisonWeapon(ctx);
    await engage();
    learnWork(session, checkpoint, template);
    shootingPause();
    const fightUntil = Date.now() + 90000;
    let nextCombatLog = Date.now() + 5000;
    let nextTacticalDecision = Date.now() + 2500;
    let breaksThisFight = 0;
    let lastTargetHits = session.world.entities.get(opponent.serial)?.hits;
    let lastDamageAt = Date.now();
    let committedUntil = Date.now() + 5000;
    let nextThreatReview = Date.now() + 2000;
    while (!session.world.deaths.has(opponent.serial)) {
      check();
      if (planStopsFight(session, opponent.serial)) throw new Retreat('Our agreed plan calls for disengaging');
      if (Date.now() >= nextThreatReview) {
        nextThreatReview = Date.now() + 2000;
        const review = encounterTarget({
          current: session.world.entities.get(opponent.serial) ?? opponent,
          self: ctx.serial,
          allies: new Set(visibleAllies(session).map((ally) => ally.serial)),
          entities: ctx.nearby().filter((entity) => !session.world.deaths.has(entity.serial)),
          swings: session.world.swings,
          origin: position(),
          committedUntil,
          eligible: (entity) => engageable(ctx, entity).ok
        });
        if (review.overwhelmed) throw new Retreat(review.reason);
        if (review.target.serial !== opponent.serial) {
          recordOutcome('interrupted');
          decisions?.finish(
            checkpoint,
            tacticalDecision,
            'interrupted',
            'Encounter changed to a confirmed additional attacker'
          );
          tacticalDecision = null;
          opponent = review.target;
          state.fightingSerial = opponent.serial;
          startedAt = Date.now();
          memoryId = randomUUID();
          encounterPlace = { map: session.world.map ?? 1, ...position() };
          initialHealth = status().hits / Math.max(1, status().maxHits);
          trip.encounter = {
            opponent: opponent.serial,
            startedAt: new Date(startedAt).toISOString(),
            position: { ...position() },
            body: opponent.graphic,
            memoryId
          };
          phase('changing-target', review.reason ?? 'Responding to a new attacker');
          await engage();
          shootingPause();
          committedUntil = Date.now() + 5000;
          lastTargetHits = session.world.entities.get(opponent.serial)?.hits;
          lastDamageAt = Date.now();
        }
      }
      const assessment = combatAssessment();
      if (
        Date.now() >= nextTacticalDecision &&
        (assessment.healthRatio < 0.82 || assessment.largestHit >= status().maxHits * 0.15)
      ) {
        let choice = assessment.baseline;
        if (choice === 'bandage-break' && breaksThisFight >= 2) choice = 'flee-town';
        if (decisions && !assessment.emergency && choice !== 'flee-town') {
          const observedTarget = opponent.serial,
            healthBand = Math.floor(assessment.healthRatio * 10);
          const pick = await decisions.choose({
            kind: 'combat-tactics',
            checkpoint,
            observationRevision: session.world.revision,
            state: decisionState(session, template, checkpoint, {
              profession: template.archetype?.id ?? 'swordsman',
              opponent: observedTarget,
              combat: assessment,
              healthChanges: session.world.healthChanges.slice(-12),
              bandages: count(bandage),
              bandageActiveUntil: combat.bandageActiveUntil,
              completedBandages: stats.completedBandages,
              failedBandages: stats.failedBandages,
              potions: count(healPotion),
              breaksThisFight,
              note: 'Incoming damage is gross observed health loss, not net loss after healing. Bandages can fail. A short withdrawal must keep moving away from threats until actual recovery is observed; re-engage only if safe. Very large bursts and imminent death are overridden locally.'
            }),
            candidates: [
              {
                id: 'press-attack',
                description:
                  'Keep attacking this opponent, using local self-healing when appropriate; only viable while recent damage remains survivable.',
                valid: () => !combatAssessment().emergency && combatAssessment().baseline !== 'flee-town'
              },
              {
                id: 'bandage-break',
                description:
                  'Run a few tiles away, self-bandage while maintaining distance, then re-engage the same opponent if recovery is confirmed. Otherwise retreat fully.',
                valid: () =>
                  breaksThisFight < 2 &&
                  status().hits < status().maxHits * 0.9 &&
                  (count(bandage) > 0 || combat.bandageActiveUntil > Date.now()) &&
                  !combatAssessment().emergency &&
                  combatAssessment().baseline !== 'flee-town'
              },
              {
                id: 'flee-town',
                description:
                  'Disengage fully and return to Britain to recover and bank; choose this when the damage rate, healing failures or supplies make another exchange unsafe.',
                valid: () => true
              }
            ],
            baseline: choice,
            stillCurrent: () =>
              !stopping?.() &&
              session.phase === 'ready' &&
              !dead() &&
              session.world.combatant === observedTarget &&
              Math.floor(combatAssessment().healthRatio * 10) === healthBand &&
              !combatAssessment().emergency &&
              combatAssessment().baseline !== 'flee-town'
          });
          check();
          if (!pick) {
            const fresh = combatAssessment();
            if (fresh.baseline === 'flee-town') throw new Retreat(fresh.reason);
            nextTacticalDecision = Date.now() + 500;
            continue;
          }
          tacticalDecision = pick;
          choice = pick.id as typeof choice;
        }
        nextTacticalDecision = Date.now() + 6000;
        if (choice === 'flee-town') throw new Retreat(assessment.reason);
        if (choice === 'bandage-break') {
          breaksThisFight++;
          try {
            await bandageBreak(opponent.serial);
          } catch (error) {
            if (session.phase === 'ready' && !stopping?.() && (error instanceof Retreat || error instanceof Died)) {
              rememberExperience(checkpoint, {
                kind: 'recovery',
                id: `${memoryId}:break:${breaksThisFight}`,
                at: Date.now(),
                ...encounterPlace,
                outcome: 'failed-break'
              });
              ctx.persist();
            }
            if (error instanceof Died || error instanceof Retreat || stopping?.() || session.phase !== 'ready')
              throw error;
            throw new Retreat(
              `Short recovery route failed: ${error instanceof Error ? error.message : 'unknown movement failure'}`
            );
          }
          await engage();
          decisions?.finish(
            checkpoint,
            tacticalDecision,
            'completed',
            `Short withdrawal recovered to ${status().hits}/${status().maxHits}; re-engaging the same opponent.`
          );
          tacticalDecision = null;
          rememberExperience(checkpoint, {
            kind: 'recovery',
            id: `${memoryId}:break:${breaksThisFight}`,
            at: Date.now(),
            ...encounterPlace,
            outcome: 'reengaged'
          });
          ctx.persist();
          nextTacticalDecision = Date.now() + 6000;
          lastDamageAt = Date.now();
          continue;
        }
        decisions?.finish(
          checkpoint,
          tacticalDecision,
          'completed',
          'Continuing the same fight under local damage monitoring and healing. This records a tactical action, not a victory.'
        );
        tacticalDecision = null;
      }
      await heal();
      if (session.world.deaths.has(opponent.serial)) break;
      const target = session.world.entities.get(opponent.serial);
      if (!target?.position || !nearAnyGround(position()) || Date.now() > fightUntil)
        throw new Retreat('Opponent left the hunting area or fight took too long');
      const damage = session.world.damage.get(opponent.serial);
      if (damage && damage.at > lastDamageAt) lastDamageAt = damage.at;
      if (target.hits !== undefined && target.hits !== lastTargetHits) {
        lastTargetHits = target.hits;
        lastDamageAt = Date.now();
      }
      if (Date.now() - lastDamageAt > 20000)
        throw new Retreat('No confirmed damage for 20 seconds; abandoning an ineffective fight');
      if (session.world.combatant !== opponent.serial) await engage();
      if (archer && ranged && count(ranged.ammo) === 0) throw new Retreat(`Out of ${ranged.name} ammunition`);
      if (mage) await castTurn(ctx, target, caster);
      const gap = distance(position(), target.position);
      if ((archer || caster) && gap <= 2) await reposition(target);
      else if (gap > maxRange || (gap > reach && Date.now() >= shootUntil)) {
        if ((archer || caster) && gap <= maxRange + 4) await reposition(target);
        else {
          await navigate(target.position, reach);
          shootingPause();
        }
      }
      if (Date.now() >= nextCombatLog) {
        log(
          `Melee target ${opponent.serial}: health ${status().hits}/${status().maxHits}; opponent ${target.hits ?? '?'}/${target.maxHits ?? '?'}; confirmed ${session.world.combatant === opponent.serial}`
        );
        try {
          await session.inspect(opponent.serial);
        } catch (error) {
          check();
          if (!session.world.deaths.has(opponent.serial))
            throw new Retreat(
              `Opponent status could not be refreshed: ${error instanceof Error ? error.message : 'unknown observation failure'}`
            );
        }
        nextCombatLog = Date.now() + 5000;
      }
      await Bun.sleep(600);
    }
    recordOutcome('victory');
    return opponent;
  } catch (error) {
    recordOutcome(
      dead()
        ? 'death'
        : session.phase !== 'ready' || stopping?.()
          ? 'interrupted'
          : error instanceof Retreat
            ? 'retreat'
            : 'interrupted'
    );
    decisions?.finish(
      checkpoint,
      tacticalDecision,
      stopping?.() ? 'interrupted' : 'failed',
      error instanceof Error ? error.message : 'Encounter failed'
    );
    throw error;
  } finally {
    state.inCombat = false;
  }
}

const ARROW = 0x0f3f;
export const fightOpponent = (...args: Parameters<typeof fightEncounter>) =>
  urgentAction(args[0].session, 'combat', () => fightEncounter(...args));
