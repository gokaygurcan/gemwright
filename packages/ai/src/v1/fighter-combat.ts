import { curePotion } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Healing, ShardMessage } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { supportPreference } from './aid';
import { combatCapability } from './combat-capability';
import { forecastFight } from './combat-forecast';
import { assessCombat } from './combat-risk';
import { bandageAdvice, encounterAdvice, rememberExperience } from './experience';
import { bandage, type FighterContext, healPotion, observedThreat, Retreat } from './fighter-context';
import { recognised } from './fighter-prey';
import { allyUnderPressure, groupMember, refreshAllyHealth } from './group-awareness';
import { distance } from './navigation';
import { rememberPartner } from './resident-memory';
import { selfState } from './self-state';

export function createFighterCombat(ctx: FighterContext) {
  const {
    session,
    template,
    terrain,
    serial,
    position,
    status,
    dead,
    contents,
    count,
    nearby,
    check,
    phase,
    escapeNavigate,
    deadline,
    state,
    stats
  } = ctx;
  let bandageUntil = 0,
    potionUntil = 0,
    bandageActiveUntil = 0;
  let cureUntil = 0;
  let bandageFeedbackAfter = session.world.journal.at(-1);
  let bandageStartedAt = 0;
  let bandageForHealing = true;
  let bandagedAlly: { serial: number; hits: number; name: string } | undefined;
  const updateBandage = () => {
    if (!bandageActiveUntil) return;
    const entries = bandageFeedbackAfter
      ? session.world.journal.slice(session.world.journal.indexOf(bandageFeedbackAfter) + 1)
      : session.world.journal;
    const completion = entries.find(
      (entry) =>
        Date.parse(entry.at) >= bandageStartedAt &&
        [Healing.barelyHelp, ShardMessage.bandagesApplied, Healing.diedMidway, Healing.outOfRange].includes(
          entry.cliloc ?? 0
        )
    );
    if (completion || Date.now() > bandageActiveUntil) {
      if (bandageForHealing) {
        rememberExperience(ctx.checkpoint, {
          kind: 'bandage',
          id: `bandage:${bandageStartedAt}`,
          at: Date.now(),
          map: session.world.map ?? 1,
          ...position(),
          outcome: completion?.cliloc === ShardMessage.bandagesApplied ? 'success' : completion ? 'failure' : 'unknown',
          skill: session.world.skills.get(skillId('Healing'))?.value ?? null
        });
        ctx.persist();
      }
      if (bandagedAlly) {
        if ((session.world.entities.get(bandagedAlly.serial)?.hits ?? 0) > bandagedAlly.hits) {
          rememberPartner(ctx.checkpoint, {
            partner: bandagedAlly.serial,
            name: bandagedAlly.name,
            kind: 'support',
            result: 'completed',
            detail: 'Bandaged my injured companion and observed recovery',
            id: `bandage-ally:${bandageStartedAt}`
          });
          ctx.persist();
        }
        bandagedAlly = undefined;
      } else if (completion?.cliloc === ShardMessage.bandagesApplied) stats.completedBandages++;
      else stats.failedBandages++;
      bandageActiveUntil = 0;
      bandageUntil = Date.now() + 500;
      bandageFeedbackAfter = session.world.journal.at(-1);
    }
  };
  const combatAssessment = () => {
    updateBandage();
    const target = state.fightingSerial === null ? undefined : session.world.entities.get(state.fightingSerial);
    const experience = target?.position
      ? encounterAdvice(
          ctx.checkpoint,
          { map: session.world.map ?? 1, ...target.position },
          target.graphic,
          Date.now(),
          combatCapability(session),
          target.name
        )
      : null;
    const healing = bandageAdvice(ctx.checkpoint, session.world.skills.get(skillId('Healing'))?.value ?? null);
    const self = selfState(session, dead());
    const forecast = target
      ? forecastFight(session, target, {
          status: status(),
          casting: template.archetype?.primarySkills.includes('Magery'),
          potionReady: count(healPotion) > 0 && Date.now() >= potionUntil,
          opponents: [target, ...self.attackers.filter((mobile) => mobile.serial !== target.serial)].map((mobile) => ({
            mobile,
            weight: 1
          })),
          caution: experience?.caution,
          riskTolerance: template.behavior.riskTolerance
        })
      : undefined;
    return assessCombat({
      now: Date.now(),
      hits: status().hits,
      maxHits: status().maxHits,
      changes: session.world.healthChanges,
      bandages: count(bandage),
      bandageActiveUntil,
      potionReady: count(healPotion) > 0 && Date.now() >= potionUntil && !((session.world.poisonLevel ?? 0) > 0),
      riskTolerance: template.behavior.riskTolerance,
      secondsToDefeat: forecast?.secondsToDefeat,
      incomingPerSecond: forecast?.incomingPerSecond,
      healAmount: forecast ? forecast.healAmount * healing.successProbability : undefined,
      potionAmount: forecast?.potionAmount,
      canCreateDistance:
        !!target && recognised(target.graphic) && status().stamina > 0 && status().weight < status().maxWeight,
      opponentHealthRatio: target?.hits !== undefined && target.maxHits ? target.hits / target.maxHits : undefined
    });
  };
  const drinkPotion = () => {
    if (dead() || session.world.target) return false;
    if ((session.world.poisonLevel ?? 0) > 0) {
      const cure = contents().find((item) => item.graphic === curePotion);
      if (!cure || Date.now() < cureUntil) return false;
      session.use(cure.serial);
      cureUntil = Date.now() + 2500;
      return true;
    }
    const potion = contents().find((item) => item.graphic === healPotion);
    if (!potion || Date.now() < potionUntil || status().hits >= status().maxHits || session.world.target) return false;
    const target = state.fightingSerial === null ? undefined : session.world.entities.get(state.fightingSerial);
    if (target) {
      if (!forecastFight(session, target, { status: status(), potionReady: true }).potionAmount) return false;
    } else {
      const missing = status().maxHits - status().hits;
      const benefit = (missing * Math.min(missing, 20)) / Math.max(1, status().maxHits);
      if (benefit <= 20 / (count(healPotion) + 1)) return false;
    }
    session.use(potion.serial);
    potionUntil = Date.now() + 11000;
    return true;
  };
  const heal = async () => {
    updateBandage();
    if (dead()) return;
    if (!session.world.target) await refreshAllyHealth(session);
    const candidate = allyUnderPressure(session, 2);
    const selfDeficit = 1 - status().hits / Math.max(1, status().maxHits) + (session.world.poisonLevel ?? 0);
    const allyState = candidate && session.world.entities.get(candidate.serial);
    const allyDeficit = allyState?.maxHits ? 1 - (allyState.hits ?? allyState.maxHits) / allyState.maxHits : 0;
    const ally = allyDeficit > selfDeficit ? candidate : undefined;
    if (!ally && status().hits >= status().maxHits && !((session.world.poisonLevel ?? 0) > 0)) return;
    if (drinkPotion()) {
      const nextUseAt = Date.now() + 650;
      while (Date.now() < nextUseAt) {
        check();
        await Bun.sleep(Math.min(50, nextUseAt - Date.now()));
      }
    }
    const cloth = contents().find((item) => item.graphic === bandage);
    if (cloth && Date.now() >= bandageUntil && !session.world.target) {
      state.abandonedBandageCursor = false;
      const previous = session.world.journal.at(-1);
      session.use(cloth.serial);
      try {
        await session.waitFor(
          () => session.world.target !== null || dead() || (state.inCombat && combatAssessment().emergency),
          'bandage target',
          2000,
          { resource: 'target' }
        );
        check();
      } catch {
        state.abandonedBandageCursor = true;
        check();
        const feedback = previous
          ? session.world.journal.slice(session.world.journal.indexOf(previous) + 1)
          : session.world.journal;
        if (feedback.some((entry) => entry.cliloc === 500119)) {
          bandageUntil = Date.now() + 1000;
          return;
        }
        bandageUntil = Date.now() + 1000;
        ctx.log('Bandaging did not begin; reassessing the fight with the observed supplies');
        if (combatAssessment().baseline === 'flee-town') throw new Retreat(combatAssessment().reason);
        return;
      }
      bandageFeedbackAfter = session.world.journal.at(-1);
      bandageStartedAt = Date.now();
      const recipient = ally ? session.world.entities.get(ally.serial) : undefined;
      if (
        ally &&
        (!recipient?.position ||
          !recipient.hits ||
          !groupMember(session, ally.serial) ||
          distance(position(), recipient.position) > 2 ||
          ![1, 2].includes(recipient.notoriety ?? 0))
      ) {
        if (session.world.target) session.target(null);
        return;
      }
      bandageForHealing = !ally && !(session.world.poisonLevel ?? 0);
      bandagedAlly = recipient
        ? { serial: recipient.serial, hits: recipient.hits ?? 0, name: recipient.name ?? 'companion' }
        : undefined;
      session.target({
        serial: recipient?.serial ?? serial,
        ...(recipient?.position ?? position()),
        graphic: recipient?.graphic ?? session.world.entities.get(serial)?.graphic ?? 0
      });
      bandageUntil = Date.now() + 17000;
      bandageActiveUntil = bandageUntil;
    }
  };
  const withdrawalPoint = async (opponent: Entity) => {
    if (!opponent.position) throw new Retreat('Opponent position was lost during tactical recovery');
    const enemy = opponent.position;
    const origin = position();
    const points = [];
    for (const radius of [4, 6, 8])
      for (const [dx, dy] of [
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1]
      ]) {
        if (dx === undefined || dy === undefined) continue;
        const point = terrain.stand(origin.x + dx * radius, origin.y + dy * radius, origin.z);
        if (!point || distance(point, enemy) < Math.max(4, distance(origin, enemy) + 2)) continue;
        if (
          nearby().some(
            (mobile) =>
              mobile.serial !== opponent.serial &&
              observedThreat(mobile, session.world.combatant) &&
              mobile.position &&
              distance(point, mobile.position) < 4
          )
        )
          continue;
        const path = await terrain.pathAsync(origin, point, 0, undefined, undefined, session.signal);
        if (!path?.length || path.length > 18) continue;
        points.push({
          point,
          score:
            path.length +
            distance(point, ctx.services.bank) * 0.03 -
            distance(point, enemy) * 0.5 +
            supportPreference(session, point)
        });
      }
    points.sort((a, b) => a.score - b.score);
    if (points[0]) return points[0].point;
    const townward = await terrain.pathAsync(origin, ctx.services.bank, 4, undefined, undefined, session.signal);
    const next = townward
      ?.slice(3, 12)
      .find(
        (point) =>
          distance(point, enemy) >= Math.max(4, distance(origin, enemy) + 2) &&
          !nearby().some(
            (mobile) =>
              mobile.serial !== opponent.serial &&
              observedThreat(mobile, session.world.combatant) &&
              mobile.position &&
              distance(point, mobile.position) < 3
          )
      );
    if (next) return next;
    throw new Retreat('No short safe withdrawal route is available');
  };
  const bandageBreak = async (targetSerial: number) => {
    stats.tacticalBreaks++;
    const until = deadline;
    phase(
      'tactical-withdrawal',
      'Creating distance to self-bandage; retaining the same opponent for possible re-engagement'
    );
    session.setWarMode(false);
    let opponent = session.world.entities.get(targetSerial);
    if (!opponent) throw new Retreat('Opponent was lost before tactical recovery');
    await escapeNavigate(await withdrawalPoint(opponent), 0);
    while (Date.now() < until) {
      check();
      await heal();
      const assessment = combatAssessment();
      if (assessment.baseline === 'flee-town') throw new Retreat(assessment.reason);
      if (assessment.baseline === 'press-attack') {
        const target = session.world.entities.get(targetSerial);
        if (!target?.position || !recognised(target.graphic))
          throw new Retreat('Recovered health, but the original opponent is no longer observed');
        phase(
          're-engaging',
          `Recovered to ${status().hits}/${status().maxHits}; returning to the same observed opponent`
        );
        stats.reengagements++;
        return;
      }
      opponent = session.world.entities.get(targetSerial);
      if (opponent?.position && distance(position(), opponent.position) < 6)
        await escapeNavigate(await withdrawalPoint(opponent), 0);
      else await Bun.sleep(250);
    }
    throw new Retreat('The short bandaging withdrawal did not produce enough confirmed recovery');
  };
  return {
    combatAssessment,
    drinkPotion,
    heal,
    bandageBreak,
    get bandageActiveUntil() {
      return bandageActiveUntil;
    }
  };
}
