import { readFileSync } from 'node:fs';

import { reagentByName } from '@gemwright/common/game/items';
import { manaOf, scrollOf } from '@gemwright/common/game/rules';

// Magery spells as ServUO defines them (catalogs/magery-spells.json): number, circle, reagents, its
// scroll and the mana it costs.
const catalog = (
  JSON.parse(readFileSync(new URL('../catalogs/magery-spells.json', import.meta.url), 'utf8')) as {
    spells: { name: string; id: number; circle: number; reagents: string[] }[];
  }
).spells;

export function spellNamed(name: string) {
  const spell = catalog.find((s) => s.name === name);
  if (!spell) throw new Error(`ServUO has no spell named ${name}.`);
  return {
    id: spell.id,
    name,
    circle: spell.circle,
    scroll: scrollOf(spell.id) ?? 0,
    mana: manaOf(spell.circle),
    reagents: spell.reagents.map((r) => reagentByName[r] ?? 0)
  };
}
