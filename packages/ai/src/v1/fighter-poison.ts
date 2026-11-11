import { poisonPotion } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';

import { type FighterContext, weaponsFor } from './fighter-context';
import { answerCursor, onItem, useOn } from './target-action';

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
  const refusals = [...FAILED, ...REFUSED];
  // The skill's cursor takes the potion; the shard then asks for the blade with a cursor of its own.
  const onPotion = await useOn(session, () => session.useSkill(skillId('Poisoning')), onItem(potion), {
    label: 'poison cursor',
    refusals
  });
  if ('why' in onPotion) return ctx.log(`Poisoning did not start (${onPotion.why} ${onPotion.cliloc ?? ''})`);
  const onBlade = await answerCursor(session, onItem(weapon), { label: 'blade cursor', refusals });
  if ('why' in onBlade) return ctx.log(`Poisoning stopped before the blade (${onBlade.why} ${onBlade.cliloc ?? ''})`);
  await session
    .waitFor(() => reply() !== undefined, 'poisoning result', 5000)
    .catch((error) => {
      if (session.phase !== 'ready') throw error;
    });
  ctx.log(reply() === APPLIED ? 'Poisoned the blade' : `Poisoning the blade failed (${reply()})`);
}
