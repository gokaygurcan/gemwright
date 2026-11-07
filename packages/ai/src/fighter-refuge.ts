import { Layer } from '@gemwright/network/layers';

import { recentlyHurt, urgentAction } from './action-purpose';
import { fundsStale, spendableGold } from './bank-gold';
import { returnHome } from './cemeteries';
import { beingAttacked } from './danger-response';
import { dungeonWalker, inAnyDungeon } from './dungeon-tools';
import {
  type FighterContext,
  meleeWeapons,
  observedThreat,
  Retreat,
  weaponSkill,
  weaponsFor,
  wieldableBy
} from './fighter-context';
import { isGargoyle } from './flight';
import { packItems } from './inventory';
import { distance } from './navigation';
import { objectiveBlocked, suppliesCondition } from './objective-memory';

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

// Whether a weapon can still be had: one carried to wield, or a weapon vendor not given up on yet
// with gold to spend. Without either, the fighter hunts bare-handed (fighter-equipment.ts) instead
// of waiting in town for a weapon it cannot get.
export function weaponObtainable(ctx: FighterContext) {
  const weapons = weaponSkill(ctx.template) === 'Archery' ? weaponsFor(ctx.template) : meleeWeapons;
  const gargoyle = isGargoyle(ctx.session);
  if (
    packItems(ctx.session, ctx.backpack()).some(
      (item) => weapons.has(item.graphic) && wieldableBy(gargoyle, item.graphic)
    )
  )
    return true;
  if (!fundsStale(ctx.checkpoint) && spendableGold(ctx.session, ctx.backpack(), ctx.checkpoint) < 20) return false;
  const vendors =
    weaponSkill(ctx.template) === 'Archery'
      ? ctx.home.all('bowyer')
      : [...ctx.home.all('blacksmith'), ...ctx.home.all('weaponsmith')];
  const condition = suppliesCondition(ctx.session, ctx.checkpoint);
  return vendors.some((stop) => !objectiveBlocked(ctx.checkpoint, `weapon:${stop.x},${stop.y}`, condition));
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
