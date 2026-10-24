import { skillId } from '@gemwright/common/skills';

import { type FighterContext, weaponsFor } from './fighter-context';
import { Layer } from './protocol/layers';

export const poisonPotion = 0x0f0a;
const APPLIED = 1010517; // You apply the poison
const FAILED = [1010516, 1010518, 502148];
const REFUSED = [502139, 502145, 1060204];

// Fighters with Poisoning in their archetype (fencers) carry poison potions.
export const poisons = (ctx: FighterContext) =>
  !!ctx.template.archetype &&
  [...ctx.template.archetype.primarySkills, ...ctx.template.archetype.supportingSkills].includes('Poisoning');

// Coats the wielded blade before a fight (ServUO Poisoning: skill, then the potion, then the weapon;
// only one-handed slashing or piercing weapons take it). The charges left cannot be observed, so
// the coat is renewed before every fight while potions last; each try also trains Poisoning.
export async function poisonWeapon(ctx: FighterContext) {
  const { session } = ctx;
  if (!poisons(ctx) || session.world.target) return;
  const potion = ctx.contents().find((item) => item.graphic === poisonPotion);
  const weapon = [...session.world.entities.values()].find(
    (item) => item.parent === ctx.serial && item.layer === Layer.OneHanded && weaponsFor(ctx.template).has(item.graphic)
  );
  if (!potion || !weapon) return;
  const seen = new Set(session.world.journal);
  const reply = () =>
    session.world.journal.find((e) => !seen.has(e) && [APPLIED, ...FAILED, ...REFUSED].includes(e.cliloc ?? 0))?.cliloc;
  try {
    session.useSkill(skillId('Poisoning'));
    await session.waitFor(() => session.world.target !== null, 'poison cursor', 3000);
    session.target({ serial: potion.serial, x: 0, y: 0, z: 0, graphic: potion.graphic });
    await session.waitFor(() => session.world.target !== null || reply() !== undefined, 'blade cursor', 3000);
    if (!session.world.target) return;
    session.target({ serial: weapon.serial, x: 0, y: 0, z: 0, graphic: weapon.graphic });
    await session.waitFor(() => reply() !== undefined, 'poisoning result', 5000);
  } catch {
    if (session.world.target) session.target(null);
    return;
  }
  ctx.log(reply() === APPLIED ? 'Poisoned the blade' : `Poisoning the blade failed (${reply()})`);
}
