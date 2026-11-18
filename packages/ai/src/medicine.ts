import { bandage, curePotion, healPotion, spellbook } from '@gemwright/common/game/items';
import { ShardMessage } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';

import type { Mind } from './mind';
import { screenOf } from './perceive';
import { spellNamed } from './spell-rules';
import { onItem, useOn } from './target-action';

export type Treatment =
  | { kind: 'potion' | 'bandage'; serial: number; cure: boolean }
  | { kind: 'spell'; spell: number; cure: boolean };

export function treatment(mind: Mind): Treatment | undefined {
  const health = mind.self.health;
  const cure = mind.self.poison > 0;
  if (!health || (!cure && health.current >= health.max)) return undefined;
  const view = mind.has();
  const carried = view.pack.map((item) => ({ ...item, graphic: mind.graphicOf(item.serial) }));
  const potion = carried.find((item) => item.graphic === (cure ? curePotion : healPotion));
  const missing = health.max - health.current;
  const potions = carried.filter((item) => item.graphic === healPotion).reduce((n, item) => n + (item.amount ?? 1), 0);
  // Preserve v1's healing-potion economy; a cure is useful whenever poisoned.
  if (potion && (cure || (missing * Math.min(missing, 20)) / Math.max(1, health.max) > 20 / (potions + 1)))
    return { kind: 'potion', serial: potion.serial, cure };
  const cloth = carried.find((item) => item.graphic === bandage);
  if (cloth && (!cure || (mind.skill('Healing') >= 60 && mind.skill('Anatomy') >= 60)))
    return { kind: 'bandage', serial: cloth.serial, cure };
  const spell = spellNamed(cure ? 'Cure' : 'Heal');
  if (
    !mind.spellMissing(spell.id) &&
    mind.skill('Magery') >= 14.3 * (spell.circle - 1) &&
    (mind.self.mana?.current ?? 0) >= spell.mana &&
    [...carried, ...view.worn.map((item) => ({ graphic: mind.graphicOf(item.serial) }))].some(
      (item) => item.graphic === spellbook
    ) &&
    spell.reagents.every((graphic) => carried.some((item) => item.graphic === graphic))
  )
    return { kind: 'spell', spell: spell.id, cure };
  return undefined;
}

export async function takeTreatment(
  session: PlayerSession,
  mind: Mind,
  treatment: Treatment,
  going: () => boolean | Promise<boolean>
) {
  const world = screenOf(session);
  const before = world.status?.hits ?? 0;
  const heard = new Set(world.journal);
  const changed = () => (treatment.cure ? world.poisonLevel === 0 : (world.status?.hits ?? before) > before);
  if (!(await going())) return false;
  if (world.target) session.target(null);
  if (treatment.kind === 'potion') session.use(treatment.serial);
  else {
    const self = world.entities.get(world.serial ?? -1);
    if (!self) return false;
    const result = await useOn(
      session,
      () => (treatment.kind === 'spell' ? session.useSkill(treatment.spell, true) : session.use(treatment.serial)),
      onItem(self),
      { label: 'self-treatment cursor', refusals: [ShardMessage.noSuchSpell, 502632, 502625, 502630] }
    );
    if ('why' in result) {
      if (
        treatment.kind === 'spell' &&
        world.journal.some((e) => !heard.has(e) && e.cliloc === ShardMessage.noSuchSpell)
      )
        mind.refuseSpell(treatment.spell);
      return false;
    }
  }
  // v1 allows seventeen seconds for a self-bandage; potions and spells use the normal result window.
  for (const end = Date.now() + (treatment.kind === 'bandage' ? 17_000 : 3000); Date.now() < end; ) {
    if (!(await going())) return false;
    if (changed()) return true;
    if (
      world.journal.some(
        (e) =>
          !heard.has(e) && [1010060, 500968, 500963, 500962, 502632, ShardMessage.noSuchSpell].includes(e.cliloc ?? 0)
      )
    )
      return false;
    await Bun.sleep(100);
  }
  return false;
}
