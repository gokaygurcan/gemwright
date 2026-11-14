import { TileFlag } from '@gemwright/common/assets/tiledata';
import { isA, skillOf } from '@gemwright/common/game/rules';
import { Layer } from '@gemwright/network/layers';

import type { Terrain } from '../terrain';
import type { Mind } from './mind';

export function weaponSkill(name: string) {
  return name
    .split('/')
    .map((type) => skillOf(type))
    .find(Boolean);
}

export function equipmentToKeep(mind: Mind, terrain?: Terrain, bank = false) {
  const slots = new Map<number, number>();
  type Hand = { serial: number; skill?: string; layer: number; worth: number };
  const weapons: Hand[] = [];
  const shields: Hand[] = [];
  for (const [serial, item] of mind.belongings()) {
    const graphic = mind.graphicOf(serial);
    if (
      graphic === undefined ||
      (!(bank && mind.banked(serial)) && !mind.carrying(serial)) ||
      item.name === 'DeathRobe' ||
      mind.deathRobe(serial)
    )
      continue;
    const skill = weaponSkill(item.name);
    const tile = terrain?.tile?.(graphic, true);
    const wearable = tile && (tile.flags & TileFlag.Wearable) !== 0;
    if (skill) {
      weapons.push({
        serial,
        skill,
        layer: tile?.layer === Layer.TwoHanded ? Layer.TwoHanded : Layer.OneHanded,
        worth: mind.worthOf(serial)
      });
      continue;
    }
    if (item.name.split('/').some((type) => isA(type, 'BaseShield'))) {
      shields.push({ serial, layer: Layer.TwoHanded, worth: mind.worthOf(serial) });
      continue;
    }
    const layer = wearable ? tile.layer : undefined;
    if (
      !layer ||
      new Set<number>([
        Layer.OneHanded,
        Layer.TwoHanded,
        Layer.Backpack,
        Layer.Bank,
        Layer.Hair,
        Layer.FacialHair,
        Layer.Mount
      ]).has(layer)
    )
      continue;
    const previous = slots.get(layer);
    if (previous === undefined || mind.worthOf(serial) > mind.worthOf(previous)) slots.set(layer, serial);
  }
  for (const serial of armed(mind, weapons, shields)) slots.set(-serial, serial);
  return new Set(slots.values());
}

// What it holds in its hands: a weapon of the skill it is best at, and a shield only where it
// parries better with it (BaseWeapon.CheckParry, self.ts): one-handed beside a shield when the
// shield adds more than a two-handed weapon parries on its own, else the two-handed one. With no
// parrying a shield blocks nothing, and it doubles down on a two-handed weapon.
function armed(
  mind: Mind,
  weapons: readonly { serial: number; skill?: string; layer: number; worth: number }[],
  shields: readonly { serial: number; worth: number }[]
) {
  const parry = mind.self.abilities().parry;
  const best = <T extends { worth: number }>(list: readonly T[]) =>
    list.reduce<T | undefined>((top, item) => (!top || item.worth > top.worth ? item : top), undefined);
  const shield = best(shields);
  const skill = weapons.reduce<string | undefined>(
    (top, w) => (top === undefined || mind.skill(w.skill ?? '') > mind.skill(top) ? w.skill : top),
    undefined
  );
  const ours = weapons.filter((w) => w.skill === skill);
  const one = best(ours.filter((w) => w.layer === Layer.OneHanded));
  const two = best(ours.filter((w) => w.layer === Layer.TwoHanded));
  if (shield && one && parry.shield > parry.twoHanded) return [one.serial, shield.serial];
  if (two) return [two.serial];
  if (one) return shield && parry.shield > parry.oneHanded ? [one.serial, shield.serial] : [one.serial];
  return shield && parry.shield > 0 ? [shield.serial] : [];
}

// What kind of thing an item is, as its type names say (the first that fits, shields before armor).
const kinds = [
  ['gold', ['Gold']],
  ['weapon', ['BaseWeapon']],
  ['shield', ['BaseShield']],
  ['armor', ['BaseArmor']],
  ['jewelry', ['BaseJewel']],
  ['clothing', ['BaseClothing']],
  ['tool', ['BaseTool', 'BaseHarvestTool']],
  ['reagent', ['BaseReagent']],
  ['bandage', ['Bandage']],
  ['potion', ['BasePotion']],
  ['food', ['Food', 'BaseBeverage']],
  ['resource', ['BaseOre', 'BaseIngot', 'BaseLog', 'BaseWoodBoard', 'BaseLeather', 'BaseHides', 'BaseGranite']],
  ['container', ['Container']]
] as const;
export type ItemKind = (typeof kinds)[number][0] | 'other';
// A name's kind never changes: worked out once, through the class tree, then remembered.
const known = new Map<string, ItemKind>();
export function kindOf(name: string): ItemKind {
  let kind = known.get(name);
  if (kind === undefined) {
    const types = name.split('/');
    kind = [...kinds].find(([, roots]) => types.some((type) => roots.some((root) => isA(type, root))))?.[0] ?? 'other';
    known.set(name, kind);
  }
  return kind;
}
