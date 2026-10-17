import type { Expansion } from '../../config';
import { expansions } from '../../config';

export interface SphereRules {
  combatFlags: number;
  archeryMovementDelay: number;
  damageEra: number;
  hitChanceEra: number;
  speedEra: number;
  speedScaleFactor: number;
  magicFlags: number;
  racialFlags: number;
  revealFlags: number;
  npcAI: number;
}

export const ruleFlags = {
  combatFlags: [
    [0x1, 'Do not turn toward combat targets'],
    [0x2, 'Require facing the target'],
    [0x4, 'Instant first melee hit (prehit)'],
    [0x8, 'Elemental damage and resistances (AOS)'],
    [0x10, 'Destroy items when maximum durability reaches zero'],
    [0x20, 'Double-click yourself in combat to dismount'],
    [0x40, 'Allow attacks from ships'],
    [0x80, 'Pets stay loyal when attacked by their owner'],
    [0x100, 'Allow archery while moving'],
    [0x200, 'Cancel swings when the target leaves range'],
    [0x400, 'Retaliate as soon as an attack is noticed'],
    [0x800, 'Hide NPC attack announcements'],
    [0x1000, 'Stack armor coverage'],
    [0x2000, 'Disable legacy poison-on-hit behavior']
  ],
  magicFlags: [
    [0x1, 'Do not turn while casting or targeting'],
    [0x2, 'Precast spells before selecting a target'],
    [0x4, 'Magic ignores armor rating'],
    [0x8, 'Allow spells to harm their caster'],
    [0x10, 'Allow different stat spells to stack'],
    [0x20, 'Prevent movement while casting'],
    [0x40, 'Require summoned creatures to be able to walk at their destination'],
    [0x80, 'Prevent spell fields crossing walls'],
    [0x100, 'Disable spell animations'],
    [0x200, 'Use OSI spell damage and duration formulas'],
    [0x400, 'Prevent casting while paralyzed with occupied hands'],
    [0x800, 'Apply stat changes from polymorph forms'],
    [0x1000, 'Replace existing field spells on the same tile']
  ],
  racialFlags: [
    [0x1, 'Human: +60 carrying capacity'],
    [0x2, 'Human: +2 hit point regeneration'],
    [0x4, 'Human: gather additional resources'],
    [0x8, 'Human: minimum 20 skill for untrained abilities'],
    [0x10, 'Elf: permanent night sight'],
    [0x20, 'Elf: harder to track while hidden'],
    [0x40, 'Elf: +20 maximum mana'],
    [0x80, 'Gargoyle: flight (requires AOS ability book features)'],
    [0x100, 'Gargoyle: berserk damage bonuses when injured'],
    [0x200, 'Gargoyle: minimum 20 Throwing skill'],
    [0x400, 'Gargoyle: minimum 30 Mysticism skill']
  ],
  revealFlags: [
    [0x1, 'Reveal when using Detecting Hidden'],
    [0x2, 'Reveal when looting your own corpse'],
    [0x4, 'Reveal when looting other corpses'],
    [0x8, 'Reveal when speaking'],
    [0x10, 'Reveal when casting spells']
  ],
  npcAI: [
    [0x1, 'Advanced pathfinding (increases CPU usage)'],
    [0x2, 'Search for food when hungry'],
    [0x4, 'Human NPCs equip weapons and night lights'],
    [0x8, 'Use maximum pathfinding intelligence (requires advanced pathfinding)'],
    [0x10, 'Intelligent food search'],
    [0x40, 'Cast helpful spells on allies during combat'],
    [0x100, 'Loot nearby items and corpses'],
    [0x200, 'Move items blocking the path when able to use hands'],
    [0x400, 'Keep pursuing unreachable targets'],
    [0x800, 'Choose combat targets by threat instead of distance']
  ]
} as const;

export function atLeast(expansion: Expansion, minimum: Expansion): boolean {
  return (
    expansions.findIndex((entry) => entry.value === expansion) >=
    expansions.findIndex((entry) => entry.value === minimum)
  );
}

export function sphereNumber(value: string): number {
  if (!/^(?:0[0-9a-fA-F]*|[1-9][0-9]*)(?:\|(?:0[0-9a-fA-F]*|[1-9][0-9]*))*$/.test(value))
    throw new Error(`Unsupported Sphere numeric expression: ${value}`);
  return value.split('|').reduce((result, part) => {
    const number = Number.parseInt(part, part.startsWith('0') ? 16 : 10);
    if (!Number.isSafeInteger(number) || number > 0x7fffffff)
      throw new Error(`Sphere numeric expression is out of range: ${value}`);
    return result | number;
  }, 0);
}

export function flagValue(value: number): string {
  return value ? `0${value.toString(16)}` : '0';
}

export function validateRules(rules: SphereRules): void {
  for (const key of Object.keys(ruleFlags) as (keyof typeof ruleFlags)[]) {
    if (!Number.isInteger(rules[key]) || rules[key] < 0 || rules[key] > 0x7fffffff)
      throw new Error(`Invalid Sphere ${key}.`);
  }
  for (const [key, maximum] of [
    ['damageEra', 2],
    ['hitChanceEra', 2],
    ['speedEra', 4],
    ['archeryMovementDelay', 2147483647],
    ['speedScaleFactor', 2147483647]
  ] as const) {
    if (
      !Number.isInteger(rules[key]) ||
      rules[key] < 0 ||
      rules[key] > maximum ||
      (key === 'speedScaleFactor' && rules[key] === 0)
    )
      throw new Error(`Invalid Sphere ${key}.`);
  }
  if (rules.npcAI & 0x8 && !(rules.npcAI & 0x1))
    throw new Error('Maximum NPC pathfinding intelligence requires advanced pathfinding.');
}

export function expansionFlags(expansion: Expansion, optionFlags: number, extraFlags: number) {
  const options =
    (optionFlags & ~0x2016) |
    (atLeast(expansion, 'hs') ? 0 : 0x2) |
    (atLeast(expansion, 'aos') ? 0x10 : 0x4) |
    (atLeast(expansion, 'ml') ? 0x2000 : 0);
  const extra =
    (extraFlags & ~0x1f) |
    (atLeast(expansion, 'ml') ? 0x1 : 0) |
    (atLeast(expansion, 'sa') ? 0x6 : 0) |
    (atLeast(expansion, 'tol') ? 0x18 : 0);
  return { OptionFlags: flagValue(options), FeatureExtra: flagValue(extra) };
}
