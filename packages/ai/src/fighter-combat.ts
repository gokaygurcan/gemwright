import { skillId } from '@gemwright/common/skills';

import { assessCombat } from './combat-risk';
import { bandageAdvice, encounterAdvice, rememberExperience } from './experience';
import { bandage, curePotion, type FighterContext, healPotion, observedThreat, Retreat } from './fighter-context';
import { recognised } from './fighter-prey';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

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
  const updateBandage = () => {
    if (!bandageActiveUntil) return;
    const entries = bandageFeedbackAfter
      ? session.world.journal.slice(session.world.journal.indexOf(bandageFeedbackAfter) + 1)
      : session.world.journal;
    const completion = entries.find(
      (entry) =>
        Date.parse(entry.at) >= bandageStartedAt && [500968, 500969, 500962, 500963].includes(entry.cliloc ?? 0)
    );
    if (completion || Date.now() > bandageActiveUntil) {
      if (bandageForHealing) {
        rememberExperience(ctx.checkpoint, {
          kind: 'bandage',
          id: `bandage:${bandageStartedAt}`,
          at: Date.now(),
          map: session.world.map ?? 1,
          ...position(),
          outcome: completion?.cliloc === 500969 ? 'success' : completion ? 'failure' : 'unknown',
          skill: session.world.skills.get(skillId('Healing'))?.value ?? null
        });
        ctx.persist();
      }
      if (completion?.cliloc === 500969) stats.completedBandages++;
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
      ? encounterAdvice(ctx.checkpoint, { map: session.world.map ?? 1, ...target.position }, target.graphic)
      : null;
    const healing = bandageAdvice(ctx.checkpoint, session.world.skills.get(skillId('Healing'))?.value ?? null);
    return assessCombat({
      now: Date.now(),
      hits: status().hits,
      maxHits: status().maxHits,
      changes: session.world.healthChanges,
      bandages: count(bandage),
      bandageActiveUntil,
      potionReady: count(healPotion) > 0 && Date.now() >= potionUntil && !((session.world.poisonLevel ?? 0) > 0),
      riskTolerance: Math.max(
        0,
        template.behavior.riskTolerance - (experience?.caution ?? 0) - (healing.unreliable ? 0.15 : 0)
      ),
      canCreateDistance:
        !!target &&
        recognised(target.graphic) &&
        status().stamina >= status().maxStamina * 0.35 &&
        status().weight < status().maxWeight * 0.95,
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
    if (!potion || Date.now() < potionUntil || status().hits >= status().maxHits * 0.65 || session.world.target)
      return false;
    session.use(potion.serial);
    potionUntil = Date.now() + 11000;
    return true;
  };
  const heal = async () => {
    updateBandage();
    if (dead() || (status().hits >= status().maxHits && !((session.world.poisonLevel ?? 0) > 0))) return;
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
          2000
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
        throw new Retreat('Bandaging did not begin; returning to town rather than continuing without healing');
      }
      bandageFeedbackAfter = session.world.journal.at(-1);
      bandageStartedAt = Date.now();
      bandageForHealing = !(session.world.poisonLevel ?? 0);
      session.target({ serial, ...position(), graphic: session.world.entities.get(serial)?.graphic ?? 0 });
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
          score: path.length + distance(point, ctx.home.town) * 0.03 - distance(point, enemy) * 0.5
        });
      }
    points.sort((a, b) => a.score - b.score);
    if (points[0]) return points[0].point;
    const homeward = await terrain.pathAsync(origin, ctx.home.town, 4, undefined, undefined, session.signal);
    const next = homeward
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
    const initial = status().hits;
    const until = Math.min(deadline, Date.now() + 24000);
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
      if (
        status().hits >= status().maxHits * 0.8 &&
        status().hits > initial &&
        !assessment.emergency &&
        !(session.world.poisonLevel ?? 0)
      ) {
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
