import { randomUUID } from 'node:crypto';

import { Blocked } from './blocked';
import { nearAnyGround } from './cemeteries';
import { type DecisionCoordinator, type DecisionPick, decisionState } from './decisions';
import { rememberExperience } from './experience';
import type { createFighterCombat } from './fighter-combat';
import { bandage, Died, type FighterContext, healPotion, Retreat, weaponSkill } from './fighter-context';
import { poisonWeapon } from './fighter-poison';
import { castTurn } from './mage-combat';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

export async function fightOpponent(
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
  const startedAt = Date.now();
  const memoryId = randomUUID();
  const encounterPlace = { map: session.world.map ?? 1, ...position() };
  const initialHealth = status().hits / Math.max(1, status().maxHits);
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
    const archer = weaponSkill(ctx.template) === 'Archery';
    // Primary casters fight from range and cast offensively; Magery as a support skill only heals.
    const caster = !!ctx.template.archetype?.primarySkills.includes('Magery');
    const mage = caster || !!ctx.template.archetype?.supportingSkills.includes('Magery');
    const reach = archer || caster ? 6 : 1;
    const engage = async () => {
      const target = session.world.entities.get(opponent.serial);
      if (!target?.position) throw new Retreat('Opponent is no longer visible');
      await navigate(target.position, reach);
      try {
        await session.attack(opponent.serial);
      } catch {
        check();
        // Out of sight from range: close in once before giving up on the target.
        if (!archer) throw new Retreat('Server did not accept the melee target after approaching');
        await navigate(target.position, 2);
        await session.attack(opponent.serial).catch(() => {
          throw new Retreat('Server did not accept the ranged target after approaching');
        });
      }
    };
    // Steps away from an adjacent opponent so the archer can stand and shoot again.
    const kite = async (target: Entity) => {
      if (!target.position) return;
      const from = position();
      const dx = Math.sign(from.x - target.position.x) || 1;
      const dy = Math.sign(from.y - target.position.y);
      const spot = ctx.terrain.stand(from.x + dx * 4, from.y + dy * 4, from.z);
      if (!spot) return;
      try {
        await navigate(spot, 1);
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
      }
    };
    await poisonWeapon(ctx);
    await engage();
    const fightUntil = Date.now() + 90000;
    let nextCombatLog = Date.now() + 5000;
    let nextTacticalDecision = Date.now() + 2500;
    let breaksThisFight = 0;
    let lastTargetHits = session.world.entities.get(opponent.serial)?.hits;
    let lastDamageAt = Date.now();
    while (!session.world.deaths.has(opponent.serial)) {
      check();
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
      if (mage) await castTurn(ctx, target, caster);
      if (distance(position(), target.position) > reach) await navigate(target.position, reach);
      else if (archer && distance(position(), target.position) <= 1) await kite(target);
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
