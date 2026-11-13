import { readFileSync } from 'node:fs';

import { carpentryTools, scribesPens, spellbook, tinkerTools } from '@gemwright/common/game/items';
import { manaOf } from '@gemwright/common/game/rules';

import { packageRoot } from '../paths';
import type { Mind } from './mind';
import type { Option } from './options';
import type { Places } from './planning';
import { prepareSpell } from './training-spells';
import { prepareTraining, type Supply } from './training-supplies';

interface Recipe {
  name: string;
  group: number;
  label: number;
  min: number;
  max: number;
  amount: number;
  pays: number;
  material?: number;
  extra?: { graphic: number; amount: number }[];
  spell?: number;
  graphic?: number;
}
interface Craft {
  graphic: number;
  recipes: Recipe[];
}
const crafts = new Map<string, Craft>();
const profiles: Record<string, { catalog: string; tools: ReadonlySet<number> }> = {
  Tinkering: { catalog: 'tinkering', tools: tinkerTools },
  Carpentry: { catalog: 'carpentry', tools: carpentryTools },
  Inscribe: { catalog: 'inscription', tools: scribesPens }
};

export function craftPractice(mind: Mind, skill: string, places: Places): Option[] {
  const profile = profiles[skill];
  if (!profile) return [];
  let craft = crafts.get(skill);
  if (!craft) {
    craft = JSON.parse(readFileSync(new URL(`catalogs/crafts/${profile.catalog}.json`, packageRoot), 'utf8')) as Craft;
    crafts.set(skill, craft);
  }
  const level = mind.self.skills.get(skill)?.base ?? 0;
  const allowed = craft.recipes.filter(
    (r) => r.min <= level && level < r.max && (!r.spell || mind.care.knownSpells.has(r.spell))
  );
  const recipe = allowed.filter((r) => r.pays > 0).at(-1) ?? allowed.at(-1);
  if (!recipe && skill === 'Inscribe') return prepareSpell(mind, places, level);
  if (!recipe) return [];
  const needs: Supply[] = [
    {
      graphics: [...profile.tools],
      amount: 1,
      system: skill === 'Tinkering' ? 'DefTinkering' : skill === 'Carpentry' ? 'DefCarpentry' : 'DefInscription'
    },
    { graphics: [recipe.material ?? craft.graphic], amount: recipe.amount, plain: skill !== 'Inscribe' },
    ...(recipe.extra ?? []).map((n) => ({ graphics: [n.graphic], amount: n.amount }))
  ];
  if (recipe.spell) needs.push({ graphics: [spellbook], amount: 1 });
  const supply = prepareTraining(mind, skill, needs, places);
  if (!supply) return [];
  if (!supply.ready) return supply.option ? [supply.option] : [];
  const mana = recipe.spell ? manaOf(Math.ceil(recipe.spell / 8)) : 0;
  if ((mind.self.mana?.current ?? 0) < mana)
    return [
      {
        key: `recover mana for ${skill}`,
        value: mind.temper.diligence,
        seconds: 3,
        steps: [{ verb: 'rest', seconds: 3 }]
      }
    ];
  return [
    {
      key: `practise ${skill}`,
      id: `practice craft ${skill} ${recipe.label}`,
      value: mind.temper.diligence,
      seconds: 3,
      consumes: supply.consumes,
      steps: [
        {
          verb: 'craft',
          skill,
          tools: [...profile.tools],
          group: recipe.group,
          label: recipe.label,
          spell: recipe.spell
        }
      ]
    }
  ];
}
