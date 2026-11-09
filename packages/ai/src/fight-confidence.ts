import type { Entity } from '@gemwright/network/world';

import { combatCapability } from './combat-capability';
import { forecastFight } from './combat-forecast';
import { encounterAdvice } from './experience';
import type { FighterContext } from './fighter-context';
import { alliesNear } from './hunting-party';
import { canBeat, fightGroup, selfState, statsOf } from './self-state';

// By the creature's server brain (the creature rules' `ai`): archers and casters hurt from beyond
// melee reach, so damage from them comes with no swing nearby.
const RANGED = new Set(['Mage', 'NecroMage', 'Spellbinder', 'Spellweaving', 'Mystic', 'Necro', 'Archer', 'OrcScout']);
export const strikesFromAfar = (mobile: Entity) => RANGED.has(statsOf(mobile)?.ai ?? '');

// Whether a fighter takes on `target`, sized up as a player does: the whole fight it would bring
// (self-state.ts), its own gear, skills, health and supplies, allies near, its nerve, and what it
// learned the last times it fought here.
export function fightConfidence(ctx: FighterContext, target: Entity): { ok: boolean; reason: string } {
  const at = target.position ?? ctx.position();
  const learned =
    ctx.checkpoint &&
    encounterAdvice(
      ctx.checkpoint,
      { map: ctx.session.world.map ?? 1, ...at },
      target.graphic,
      Date.now(),
      combatCapability(ctx.session),
      target.name
    );
  const { hits, maxHits } = ctx.status();
  const self = { ...selfState(ctx.session, ctx.dead()), hits, maxHits };
  const seen = ctx.nearby();
  const ok = canBeat(ctx.session, self, target, {
    party: alliesNear(ctx, at).length + 1,
    caution: learned?.caution,
    riskTolerance: ctx.template.behavior.riskTolerance,
    casting: ctx.template.archetype?.primarySkills.includes('Magery'),
    seen
  });
  const group = fightGroup(ctx.session, self, target, seen);
  const forecast = forecastFight(ctx.session, target, {
    status: ctx.status(),
    opponents: group.map((mobile) => ({ mobile, weight: 1 }))
  });
  return {
    ok,
    reason: `${group.length} in the fight; incoming ${forecast.incomingPerSecond.toFixed(2)} hp/s, ${forecast.secondsToDefeat.toFixed(2)}s for the first`
  };
}
