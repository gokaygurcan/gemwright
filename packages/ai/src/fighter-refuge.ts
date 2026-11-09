import { Layer } from '@gemwright/network/layers';

import { recentlyHurt, urgentAction } from './action-purpose';
import { returnToNearestTown } from './cemeteries';
import { beingAttacked, escapeDanger } from './danger-response';
import { dungeonWalker, inAnyDungeon } from './dungeon-tools';
import { strikesFromAfar } from './fight-confidence';
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
        distance(ctx.position(), mobile.position) < (strikesFromAfar(mobile) ? 14 : 8)
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

export async function returnToRefuge(ctx: FighterContext, nearby = false) {
  const needsTown = !nearby && !!ctx.trip.recovery && ctx.trip.recovery.stage !== 'ready';
  if (!needsTown) {
    const safe = () =>
      !ctx.dead() && !recoveryThreats(ctx).length && !beingAttacked(ctx.session) && !recentlyHurt(ctx.session);
    if (!safe()) {
      ctx.phase('seeking-refuge', 'Leaving observed threats to recover nearby');
      await escapeDanger({ ...ctx, navigate: ctx.escapeNavigate }, undefined);
    }
    if (!safe()) throw new Retreat('No safe nearby recovery position was confirmed');
    if (!ctx.trip.recovery || ctx.trip.recovery.stage === 'ready') ctx.trip.pending = 'hunt';
    ctx.persist();
    ctx.phase('recovery-refuge', 'No observed threats or recent damage; recovering here');
    return;
  }
  ctx.trip.pending = 'return';
  ctx.persist();
  const safe = () =>
    !ctx.dead() &&
    distance(ctx.position(), ctx.services.bank) <= 4 &&
    !recoveryThreats(ctx).length &&
    !beingAttacked(ctx.session);
  if (!safe()) {
    await urgentAction(ctx.session, 'escape', async () => {
      const below = inAnyDungeon(ctx.position());
      if (below) await dungeonWalker(ctx, () => false).climbOut(below);
      await returnToNearestTown(ctx);
      await ctx.escapeNavigate(ctx.services.bank, 4);
    });
  }
  if (!safe()) throw new Retreat('Arrival at a safe recovery refuge was not confirmed');
}
