import { HORSE_BODIES, HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { isA } from '@gemwright/common/game/rules';
import { Notoriety } from '@gemwright/network/opcodes';

import type { Mind } from './mind';
import type { Option, Step } from './options';
import type { Places } from './planning';
import { craftPractice } from './training-crafts';
import { spellPractice } from './training-spells';

const delays: Readonly<Record<string, number>> = {
  ArmsLore: 1000,
  Anatomy: 1000,
  EvalInt: 1000,
  AnimalLore: 1000,
  Hiding: 10000,
  DetectHidden: 10000,
  Stealth: 10000,
  SpiritSpeak: 5000,
  Meditation: 5000
};

export function practice(mind: Mind, places: Places = { bankers: [], vendors: [] }): Option[] {
  if (!mind.position) return [];
  const ceiling = Math.min(...mind.tradeSkills.map((name) => mind.self.skills.get(name)?.base ?? 0)) + 20;
  const skills = [
    ...new Set([...mind.supporting, ...mind.tradeSkills.filter((s) => s === 'Necromancy' || s === 'Inscribe')])
  ];
  return skills.flatMap((skill) => {
    const sheet = mind.self.skills.get(skill);
    const delay = delays[skill];
    const limit =
      mind.inTrade(skill) && (skill === 'Inscribe' || skill === 'Necromancy')
        ? (sheet?.cap ?? 100)
        : Math.min(sheet?.cap ?? 100, ceiling);
    if (
      !sheet ||
      sheet.lock === 2 ||
      sheet.base >= limit ||
      (mind.care.cooldowns.get(`practice ${skill}`) ?? 0) > Date.now()
    )
      return [];
    if (['Tinkering', 'Carpentry', 'Inscribe'].includes(skill)) return craftPractice(mind, skill, places);
    if (skill === 'Magery' || skill === 'Necromancy') return spellPractice(mind, skill, places);
    if (!delay) return [];
    const before: Step[] = skill === 'Stealth' ? [{ verb: 'practice', skill: 'Hiding', delay: 10000 }] : [];
    if (['ArmsLore', 'Anatomy', 'EvalInt', 'AnimalLore'].includes(skill)) {
      const target =
        skill === 'ArmsLore'
          ? [...mind.belongings()].find(
              ([id, item]) =>
                mind.carrying(id) && item.name.split('/').some((t) => isA(t, 'BaseWeapon') || isA(t, 'BaseArmor'))
            )?.[0]
          : [...mind.sights()].find(
              (e) =>
                e.kind === 'mobile' &&
                e.serial !== mind.serial &&
                e.notoriety !== Notoriety.invulnerable &&
                e.position &&
                mind.position &&
                Math.max(Math.abs(e.position.x - mind.position.x), Math.abs(e.position.y - mind.position.y)) <= 8 &&
                (HORSE_BODIES.has(e.graphic ?? 0) || (skill !== 'AnimalLore' && HUMAN_ELF_BODIES.has(e.graphic ?? 0)))
            )?.serial;
      if (target === undefined) return [];
      return [
        {
          key: `practise ${skill}`,
          id: `practice ${skill} ${target}`,
          value: mind.temper.diligence,
          seconds: delay / 1000,
          steps: [...before, { verb: 'practice', skill, serial: target, delay }]
        }
      ];
    }
    if (skill === 'Meditation' && mind.self.mana && mind.self.mana.current >= mind.self.mana.max) return [];
    return [
      {
        key: `practise ${skill}`,
        value: mind.temper.diligence,
        seconds: delay / 1000,
        steps: [...before, { verb: 'practice', skill, delay, ground: skill === 'DetectHidden' }]
      }
    ];
  });
}
