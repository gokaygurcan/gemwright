import * as prompts from '@clack/prompts';

import { answer } from '../../prompts';
import { sphereConfigValue } from './config';
import { ruleFlags, type SphereRules, sphereNumber, validateRules } from './rules';

export function defaultRules(ini: string): SphereRules {
  function number(key: string, fallback?: number) {
    const value = sphereConfigValue(ini, key);
    if (value !== undefined) return sphereNumber(value);
    if (fallback !== undefined && new RegExp(`^//${key}=0(?:\\s|$)`, 'm').test(ini)) return fallback;
    throw new Error(`Missing upstream Sphere setting: ${key}.`);
  }
  return {
    combatFlags: number('CombatFlags', 0),
    archeryMovementDelay: number('CombatArcheryMovementDelay'),
    damageEra: number('CombatDamageEra'),
    hitChanceEra: number('CombatHitChanceEra'),
    speedEra: number('CombatSpeedEra'),
    speedScaleFactor: number('SpeedScaleFactor'),
    magicFlags: number('MagicFlags', 0),
    racialFlags: number('RacialFlags'),
    revealFlags: number('RevealFlags'),
    npcAI: number('NPCAI', 0)
  };
}

export async function askSphereRules(ini: string, yes: boolean): Promise<SphereRules> {
  const rules = defaultRules(ini);
  if (yes) {
    validateRules(rules);
    return rules;
  }
  async function flags(key: keyof typeof ruleFlags, message: string) {
    const options = ruleFlags[key].map(([value, label]) => ({ value: Number(value), label }));
    const known = options.reduce((mask, option) => mask | option.value, 0);
    while (true) {
      const selected = answer(
        await prompts.multiselect({
          message,
          options,
          required: false,
          maxItems: 8,
          initialValues: options.filter((option) => rules[key] & option.value).map((option) => option.value)
        })
      );
      rules[key] = (rules[key] & ~known) | selected.reduce((mask, value) => mask | value, 0);
      if (key !== 'npcAI' || !(rules.npcAI & 0x8) || rules.npcAI & 0x1) break;
      prompts.log.warn('Maximum intelligence requires advanced pathfinding. Select both or neither.');
    }
  }
  async function integer(message: string, value: number, minimum = 0) {
    return Number(
      answer(
        await prompts.text({
          message,
          placeholder: String(value),
          defaultValue: String(value),
          validate: (input) => {
            const text = input || String(value);
            return !/^\d+$/.test(text) ||
              !Number.isSafeInteger(Number(text)) ||
              Number(text) < minimum ||
              Number(text) > 2147483647
              ? `Enter a whole number from ${minimum} to 2147483647.`
              : undefined;
          }
        })
      )
    );
  }
  await flags('combatFlags', 'Combat behavior');
  if (!(rules.combatFlags & 0x100))
    rules.archeryMovementDelay = await integer(
      'Archery delay after movement (tenths of a second; pre-AOS 10, AOS 5, SE 2)',
      rules.archeryMovementDelay
    );
  const formulas = [
    { value: 0, label: 'Sphere custom' },
    { value: 1, label: 'Pre-AOS' },
    { value: 2, label: 'AOS' }
  ];
  rules.damageEra = answer(
    await prompts.select({ message: 'Physical damage formula', initialValue: rules.damageEra, options: formulas })
  );
  rules.hitChanceEra = answer(
    await prompts.select({
      message: 'Hit chance formula',
      initialValue: rules.hitChanceEra,
      options: formulas.map((option) => ({
        ...option,
        hint: option.value < 2 ? 'No Hit Chance Increase support' : 'Supports Hit Chance Increase'
      }))
    })
  );
  await flags('magicFlags', 'Magic behavior');
  await flags('racialFlags', 'Racial traits');
  await flags('revealFlags', 'Reveal invisible characters when…');
  await flags('npcAI', 'NPC intelligence');
  validateRules(rules);
  return rules;
}
