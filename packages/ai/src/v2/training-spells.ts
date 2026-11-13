import { readFileSync } from 'node:fs';

import { necroReagentByName, spellbook } from '@gemwright/common/game/items';

import { packageRoot } from '../paths';
import { spellNamed } from '../v1/spell-rules';
import type { Mind } from './mind';
import type { Option } from './options';
import type { Places } from './planning';
import { prepareTraining, type Supply } from './training-supplies';

type Spell = ReturnType<typeof spellNamed>;
const spellCatalog = JSON.parse(readFileSync(new URL('catalogs/magery-spells.json', packageRoot), 'utf8')) as {
  spells: { id: number; name: string }[];
};
const names = new Map(spellCatalog.spells.map((s) => [s.id, s.name]));
const exercises = ['Reveal', 'Magic Reflection', 'Arch Protection', 'Bless', 'Cunning', 'Heal'].map(spellNamed);
let scrolls: { min: number; max: number; spell?: number }[] | undefined;

export function learnSpell(mind: Mind, spell: Spell, places: Places, skill: string): Option[] {
  const needs: Supply[] = [{ graphics: [spellbook], amount: 1 }];
  if (mind.spellMissing(spell.id))
    needs.push({ graphics: [spell.scroll], amount: 1, scroll: { circle: spell.circle } });
  const supply = prepareTraining(mind, skill, needs, places);
  if (!supply) return [];
  if (!supply.ready) return supply.option ? [supply.option] : [];
  return [
    {
      key: `learn spell for ${skill}`,
      value: mind.temper.diligence,
      seconds: 3,
      consumes: supply.consumes,
      steps: [{ verb: 'learn-spell', spell: spell.id, scroll: spell.scroll, probe: !mind.spellMissing(spell.id) }]
    }
  ];
}

export function prepareSpell(mind: Mind, places: Places, level: number): Option[] {
  scrolls ??= (
    JSON.parse(readFileSync(new URL('catalogs/crafts/inscription.json', packageRoot), 'utf8')) as {
      recipes: typeof scrolls;
    }
  ).recipes;
  const ids = new Set(scrolls?.filter((r) => r.min <= level && level < r.max).flatMap((r) => r.spell ?? []));
  const spells = [...ids]
    .filter((id) => !mind.care.knownSpells.has(id))
    .map((id) => {
      const name = names.get(id);
      return name ? spellNamed(name) : undefined;
    })
    .filter(
      (s): s is Spell =>
        !!s &&
        (s.circle <= 3 || [...mind.belongings()].some(([id]) => mind.carrying(id) && mind.graphicOf(id) === s.scroll))
    );
  const spell = spells.at(-1);
  return spell ? learnSpell(mind, spell, places, 'Inscribe') : [];
}

export function spellPractice(mind: Mind, skill: string, places: Places): Option[] {
  if (skill === 'Necromancy') {
    if (mind.skill(skill) < 20 || mind.spellMissing(116)) return [];
    const supply = prepareTraining(
      mind,
      skill,
      [
        { graphics: [necroReagentByName.NoxCrystal as number], amount: 2 },
        { graphics: [necroReagentByName.PigIron as number], amount: 2 }
      ],
      places
    );
    if (!supply) return [];
    if (!supply.ready) return supply.option ? [supply.option] : [];
    if ((mind.self.mana?.current ?? 0) < 34) return manaRecovery(mind, skill);
    return [
      {
        key: 'practise Necromancy',
        value: mind.temper.diligence,
        seconds: 7,
        consumes: supply.consumes,
        steps: [
          { verb: 'practice', skill, spell: 116, delay: 3500 },
          { verb: 'practice', skill, spell: 116, delay: 3500 }
        ]
      }
    ];
  }
  const spell = exercises.find(
    (s) =>
      mind.skill('Magery') >= 14.3 * (s.circle - 1) - 20 &&
      mind.skill('Magery') < 14.3 * (s.circle - 1) + 20 &&
      (!mind.spellMissing(s.id) ||
        s.circle <= 3 ||
        [...mind.belongings()].some(([id]) => mind.carrying(id) && mind.graphicOf(id) === s.scroll))
  );
  if (!spell) return [];
  if (!mind.care.knownSpells.has(spell.id)) return learnSpell(mind, spell, places, skill);
  const supply = prepareTraining(
    mind,
    skill,
    [{ graphics: [spellbook], amount: 1 }, ...spell.reagents.map((g) => ({ graphics: [g], amount: 5 }))],
    places
  );
  if (!supply) return [];
  if (!supply.ready) return supply.option ? [supply.option] : [];
  if ((mind.self.mana?.current ?? 0) < spell.mana) return manaRecovery(mind, skill);
  return [
    {
      key: 'practise Magery',
      value: mind.temper.diligence,
      seconds: 4,
      consumes: supply.consumes,
      steps: [
        {
          verb: 'practice',
          skill,
          spell: spell.id,
          ...(spell.name === 'Magic Reflection' ? {} : { serial: mind.serial }),
          delay: 4000
        }
      ]
    }
  ];
}

function manaRecovery(mind: Mind, skill: string): Option[] {
  return [
    {
      key: `recover mana for ${skill}`,
      value: mind.temper.diligence,
      seconds: 3,
      steps: [{ verb: 'rest', seconds: 3 }]
    }
  ];
}
