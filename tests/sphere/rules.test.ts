import { expect, test } from 'bun:test';

import { createConfig, expansions } from '../../src/config';
import { prepareSphereFiles, sphereConfigValue } from '../../src/emulators/sphere/config';
import { expansionFlags, flagValue, sphereNumber, validateRules } from '../../src/emulators/sphere/rules';
import { defaultRules } from '../../src/emulators/sphere/rules-prompts';
import { sphereFixture, sphereSettings } from './config-fixture';

function fixtureRules() {
  return defaultRules(String(sphereFixture()['sphere.ini']));
}

test('Sphere parses native hexadecimal flags and decimal formulas without evaluating expressions', () => {
  expect(sphereNumber('01|08|020|0200|0800|02000|020000')).toBe(0x22a29);
  expect(sphereNumber('10')).toBe(10);
  expect(sphereNumber('010')).toBe(16);
  expect(sphereNumber(flagValue(0x180))).toBe(0x180);
  for (const value of ['', '1+2', '0x10', '1\n2', 'bad', '2147483648', '080000000'])
    expect(() => sphereNumber(value)).toThrow();
});

test('each expansion gates only era-specific option and extra feature bits', () => {
  const options = [
    0x20a2f, 0x20a2f, 0x20a2f, 0x20a2f, 0x20a2f, 0x20a3b, 0x20a3b, 0x22a3b, 0x22a3b, 0x22a39, 0x22a39, 0x22a39
  ];
  const extra = [0, 0, 0, 0, 0, 0, 0, 1, 7, 7, 31, 31];
  for (const [index, expansion] of expansions.entries()) {
    const flags = expansionFlags(expansion.value, 0x22a29 | 0x40000, 0x20 | 0x1f);
    expect(sphereNumber(flags.OptionFlags)).toBe(options[index]! | 0x40000);
    expect(sphereNumber(flags.FeatureExtra)).toBe(extra[index]! | 0x20);
    const upstream = sphereFixture();
    const result = prepareSphereFiles(
      upstream,
      createConfig({ emulator: 'sphere', expansion: expansion.value }),
      sphereSettings,
      'safe-password-16'
    );
    const ini = Buffer.from(result['sphere.ini']!).toString('latin1');
    expect(sphereNumber(sphereConfigValue(ini, 'OptionFlags')!)).toBe(options[index]!);
    expect(sphereNumber(sphereConfigValue(ini, 'FeatureExtra')!)).toBe(extra[index]!);
    expect(sphereConfigValue(ini, 'Experimental')).toBe('0');
  }
});

test('selected rules write native config values and ML speed enables only weapon override lines', () => {
  const upstream = sphereFixture();
  const weapon = '// unchanged \xe9\r\nSPEED=40\r\n//TAG.OVERRIDE.SPEED=35\t// ML\r\n';
  upstream['scripts/items/weapons.scp'] = Buffer.from(weapon, 'latin1');
  const rules = {
    ...fixtureRules(),
    combatFlags: 0x108,
    damageEra: 2,
    hitChanceEra: 2,
    speedEra: 4,
    magicFlags: 0x202,
    racialFlags: 0x7ff,
    revealFlags: 8,
    npcAI: 9
  };
  const result = prepareSphereFiles(
    upstream,
    createConfig({ emulator: 'sphere', expansion: 'sa' }),
    { ...sphereSettings, rules },
    'safe-password-16'
  );
  const ini = Buffer.from(result['sphere.ini']!).toString('latin1');
  for (const [key, value] of Object.entries({
    CombatFlags: '0108',
    CombatDamageEra: '2',
    CombatHitChanceEra: '2',
    CombatSpeedEra: '4',
    MagicFlags: '0202',
    RacialFlags: '07ff',
    RevealFlags: '08',
    NPCAI: '09'
  }))
    expect(sphereConfigValue(ini, key)).toBe(value);
  expect(result['scripts/items/weapons.scp']).toEqual(Buffer.from(weapon.replace('//TAG.', 'TAG.'), 'latin1'));
  expect(upstream['scripts/items/weapons.scp']).toEqual(Buffer.from(weapon, 'latin1'));
  expect(result['sphereCrypt.ini']).toEqual(upstream['sphereCrypt.ini']);
  expect(() =>
    prepareSphereFiles(
      sphereFixture(),
      createConfig({ emulator: 'sphere' }),
      { ...sphereSettings, rules },
      'safe-password-16'
    )
  ).toThrow('weapon speed overrides');
});

test('rule validation rejects invalid formulas, numeric input and missing NPC dependencies', () => {
  const rules = fixtureRules();
  expect(rules).toEqual({
    combatFlags: 0,
    archeryMovementDelay: 10,
    damageEra: 0,
    hitChanceEra: 0,
    speedEra: 0,
    speedScaleFactor: 15000,
    magicFlags: 0,
    racialFlags: 0,
    revealFlags: 31,
    npcAI: 0
  });
  expect(() => validateRules(rules)).not.toThrow();
  for (const bad of [
    { damageEra: 3 },
    { hitChanceEra: -1 },
    { speedEra: 5 },
    { speedScaleFactor: 0 },
    { combatFlags: 1.5 },
    { archeryMovementDelay: NaN },
    { npcAI: 8 }
  ])
    expect(() =>
      createConfig({ emulator: 'sphere', sphere: { ...sphereSettings, rules: { ...rules, ...bad } } })
    ).toThrow();
  expect(() => defaultRules('CombatFlags=0\n')).toThrow('Missing upstream');
});
