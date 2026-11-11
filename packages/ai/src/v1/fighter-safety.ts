import { recentlyHurt, takingUrgentAction } from './action-purpose';
import { hurtOnTheWay } from './cemeteries';
import { beingAttacked } from './danger-response';
import { checkAction } from './execution-session';
import { Died, type FighterContext, Retreat } from './fighter-context';
import { recoveryHealthReady, recoveryThreats } from './fighter-refuge';
import { assertNotHalted } from './gm';
import { checkLoop } from './loop-watch';

export function checkFighter(
  ctx: FighterContext,
  combatAssessment: () => { emergency: boolean; reason: string; largestHit: number; damagePerSecond: number },
  stopping?: () => boolean
) {
  const { session, deadline, state, dead, status, stats, phase } = ctx;
  assertNotHalted(session);
  checkAction(session);
  if (stopping?.() || Date.now() >= deadline) throw new Error('Fighter run duration reached or interrupted');
  if (session.phase !== 'ready') throw new Error('Fighter disconnected; reconcile before continuing');
  if (state.abandonedBandageCursor && session.world.target) {
    session.target(null);
    state.abandonedBandageCursor = false;
  }
  if (dead() && !state.recovering) throw new Died('Character died');
  if (
    !state.recovering &&
    !state.recoveringCorpse &&
    !state.inCombat &&
    !takingUrgentAction(session) &&
    (recentlyHurt(session) || beingAttacked(session))
  )
    hurtOnTheWay(ctx);
  if (state.recoveringCorpse && (!recoveryHealthReady(ctx) || recoveryThreats(ctx).length))
    throw new Retreat('Corpse approach became unsafe');
  if (state.inCombat) {
    const assessment = combatAssessment();
    if (assessment.emergency) {
      stats.burstEscapes++;
      phase(
        'emergency-escape',
        `${assessment.reason} Largest recent hit ${assessment.largestHit}; incoming ${assessment.damagePerSecond.toFixed(1)} HP/s; remaining ${status().hits}/${status().maxHits}.`
      );
      throw new Retreat(assessment.reason);
    }
  }
  if (!state.inCombat && !state.recovering && !state.recoveringCorpse) checkLoop(session);
}
