import { urgentAction } from './action-purpose';
import type { FighterContext } from './fighter-context';
import { engageable } from './fighter-prey';
import { townNeed } from './fighter-trip';
import { allyUnderPressure, refreshAllyHealth } from './group-awareness';
import { castTurn } from './mage-combat';
import type { Entity } from './protocol/world';
import { registerCombat } from './resident-context';

export function registerFighterSocial(
  ctx: FighterContext,
  defeat: (target: Entity) => Promise<void>,
  heal: () => Promise<void>
) {
  const { session } = ctx;
  registerCombat(session, {
    canFight: (target) => [3, 4, 5, 6].includes(target.notoriety ?? 0) && engageable(ctx, target).ok,
    fight: defeat,
    ready: () => !ctx.dead() && !townNeed(ctx)?.hard,
    support: async () => {
      if (!ctx.dead() && ctx.status().hits >= ctx.status().maxHits * 0.65 && !session.world.target)
        await refreshAllyHealth(session);
      if (!allyUnderPressure(session) || ctx.dead() || ctx.status().hits < ctx.status().maxHits * 0.65) return false;
      return urgentAction(session, 'combat', async () => {
        await heal();
        const skills = ctx.template.archetype;
        if (skills?.primarySkills.includes('Magery') || skills?.supportingSkills.includes('Magery'))
          return castTurn(
            ctx,
            session.world.entities.get(ctx.serial) ?? { serial: ctx.serial, graphic: 0, kind: 'mobile' },
            false
          );
        return false;
      });
    }
  });
}
