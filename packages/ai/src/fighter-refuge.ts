import { Layer } from '@gemwright/network/layers';

import { recentlyHurt, urgentAction } from './action-purpose';
import { returnHome } from './cemeteries';
import { beingAttacked } from './danger-response';
import { dungeonWalker, inAnyDungeon } from './dungeon-tools';
import { type FighterContext, meleeWeapons, observedThreat, Retreat, weaponSkill, weaponsFor } from './fighter-context';
import { distance } from './navigation';

export const recoveryThreats = (ctx: FighterContext) =>
  ctx
    .nearby()
    .filter(
      (mobile) =>
        mobile.position &&
        !ctx.session.world.deaths.has(mobile.serial) &&
        observedThreat(mobile, ctx.session.world.combatant) &&
        distance(ctx.position(), mobile.position) < 8
    );

export const recoveryHealthReady = (ctx: FighterContext) => {
  const status = ctx.status();
  return (
    !ctx.dead() &&
    status.maxHits > 0 &&
    status.hits >= status.maxHits * 0.9 &&
    !(ctx.session.world.poisonLevel ?? 0) &&
    !recentlyHurt(ctx.session) &&
    !beingAttacked(ctx.session)
  );
};

export function recoveryEquipmentReady(ctx: FighterContext) {
  const family = weaponSkill(ctx.template);
  if (family === 'Wrestling' || ctx.template.archetype?.primarySkills.includes('Magery')) return true;
  const weapons = family === 'Archery' ? weaponsFor(ctx.template) : meleeWeapons;
  return ctx.session.world
    .childrenOf(ctx.serial)
    .some((item) => (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) && weapons.has(item.graphic));
}

export async function returnToRefuge(ctx: FighterContext) {
  ctx.trip.pending = 'return';
  ctx.persist();
  const safe = () =>
    !ctx.dead() &&
    distance(ctx.position(), ctx.home.town) <= 4 &&
    !recoveryThreats(ctx).length &&
    !beingAttacked(ctx.session);
  if (!safe()) {
    await urgentAction(ctx.session, 'escape', async () => {
      const below = inAnyDungeon(ctx.position());
      if (below) await dungeonWalker(ctx, () => false).climbOut(below);
      await returnHome(ctx);
      await ctx.escapeNavigate(ctx.home.town, 4);
    });
  }
  if (!safe()) throw new Retreat('Arrival at a safe recovery refuge was not confirmed');
}
