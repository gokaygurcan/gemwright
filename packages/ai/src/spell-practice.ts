import { necroReagentByName } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { checkedDelay } from './action-purpose';
import { trainCraft } from './craft-training';
import { type MageryContext, shop } from './magery';
import { inscriptionCraft, knownScrolls } from './scribe';
import type { PracticeContext } from './skill-training';

// Practice for the New Haven builds' spell skills (skill-training.ts): Inscription by writing
// scrolls of the spells already in the book (a scribe's training, ServUO DefInscription), and
// Necromancy by taking Wraith Form and leaving it again (ServUO WraithFormSpell, cast as 116,
// nox crystal and pig iron, no target, so never a criminal act).
const WRAITH_FORM = 116;
const WRAITH_MANA = 17;

export async function practiseInscription(ctx: MageryContext, until: number) {
  const scrolls = knownScrolls(ctx.checkpoint.spells?.has ?? []);
  if (!scrolls.length) return 0;
  return trainCraft(
    { ...ctx, refill: (_pack, least, graphic) => shop(ctx, new Map([[graphic, Math.max(least, 10)]]), 60) },
    inscriptionCraft(scrolls),
    ctx.backpack(),
    until,
    { mode: 'training' }
  );
}

export async function practiseNecromancy(ctx: PracticeContext) {
  const { session } = ctx;
  const skill = () => session.world.skills.get(skillId('Necromancy'))?.base ?? 0;
  const has = (name: string) =>
    ctx.items().some((item) => item.graphic === necroReagentByName[name] && (item.amount ?? 1) >= 2);
  if (skill() < 20 || !has('NoxCrystal') || !has('PigIron')) return 0;
  ctx.phase('training', 'Practising Necromancy (Wraith Form)');
  let casts = 0;
  while (Date.now() < ctx.until && !ctx.interrupt?.() && skill() < 100) {
    ctx.check();
    if ((session.world.status?.mana ?? 0) < WRAITH_MANA * 2 || !has('NoxCrystal') || !has('PigIron')) break;
    if (session.world.target) break;
    // Into the form and, after a moment, out of it again: two casts, two chances to learn.
    for (let twice = 0; twice < 2; twice++) {
      session.useSkill(WRAITH_FORM, true);
      casts++;
      await checkedDelay(3500 + Math.random() * 1000, ctx.check);
    }
  }
  ctx.log(`Practised Necromancy with ${casts} casts`);
  return casts;
}
