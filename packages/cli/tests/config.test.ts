import { describe, expect, test } from 'bun:test';

import { validateSchema } from '@gemwright/common/config/compatibility';
import { expansions } from '@gemwright/common/game/expansions';
import {
  createConfig,
  defaultTimezone,
  isAcceptedTimezone,
  shardId,
  timezoneOptions,
  validateName
} from '@gemwright/server/config';

test('decision providers use one ordered representation with matching runtime and JSON schema validation', () => {
  const decisions = [
    { provider: 'clef' as const, model: 'clef-flash' },
    { provider: 'jev' as const, model: 'jev-1.14.0' },
    { provider: 'local' as const }
  ];
  const config = createConfig({ client: { version: '7.0.45.1' }, ai: { decisions } });
  expect(config.ai?.decisions).toEqual(decisions);
  expect(() => validateSchema(config)).not.toThrow();
  for (const bad of [
    [{ provider: 'clef', model: 'clef-flash', budget: 1 }, { provider: 'local' }],
    [{ provider: 'clef', model: 'jev-1.13.0' }, { provider: 'local' }],
    [{ provider: 'local' }, { provider: 'jev', model: 'jev-1.13.0' }],
    [{ provider: 'jev', model: 'jev-1.13.0' }]
  ]) {
    expect(() => validateSchema({ ...config, ai: { decisions: bad } })).toThrow();
    expect(() => createConfig({ ...config, ai: { decisions: bad as typeof decisions } })).toThrow();
  }
});

describe('shard identity', () => {
  test('drops apostrophes, folds case and collapses punctuation', () => {
    expect(shardId("  Lord British's Realm!  ")).toBe('lord-britishs-realm');
  });

  test('enforces printable ASCII and length without silently changing the name', () => {
    for (const name of ['a'.repeat(33), 'Café', 'Realm\n', 'Realm\t', '\x7f']) {
      expect(validateName(name)).toBeDefined();
    }
    expect(validateName('a'.repeat(32))).toBeUndefined();
    expect(createConfig({ client: { version: '7.0.45.1' }, name: ' My Realm ' }).name).toBe(' My Realm ');
  });

  test('defaults empty or omitted names before deriving the slug', () => {
    expect(validateName('')).toBeUndefined();
    expect(shardId('')).toBe('gemwright');
    for (const input of [{}, { name: '' }]) {
      const config = createConfig(input);
      expect(config.name).toBe('Gemwright');
      expect(config.id).toBe('gemwright');
    }
  });

  test('preserves the specified rules for punctuation-only names', () => {
    expect(validateName(" '!? ")).toBeUndefined();
    expect(shardId(" '!? ")).toBe('');
  });
});

describe('shard settings', () => {
  test('accepts enabled emulators and rejects unavailable ones', () => {
    for (const emulator of ['servuo', 'sphere', 'sphere-x', 'runuo', 'modernuo'] as const) {
      expect(createConfig({ client: { version: '7.0.45.1' }, emulator }).emulator).toBe(emulator);
    }
    for (const emulator of ['pol', 'unknown']) {
      expect(() => createConfig({ client: { version: '7.0.45.1' }, emulator })).toThrow('Unsupported emulator');
    }
  });

  test('defaults to Endless Journey and an accepted local or fallback zone', () => {
    expect(createConfig({ client: { version: '7.0.45.1' }, name: 'Britannia' })).toEqual({
      name: 'Britannia',
      id: 'britannia',
      timezone: defaultTimezone(),
      expansion: 'ej',
      client: { version: '7.0.45.1' },
      emulator: 'servuo'
    });
    expect(isAcceptedTimezone(defaultTimezone())).toBe(true);
  });

  test('accepts all twelve expansion codes and rejects unknown values', () => {
    expect(expansions).toHaveLength(12);
    for (const { value } of expansions) {
      expect(createConfig({ client: { version: '7.0.45.1' }, name: 'Realm', expansion: value }).expansion).toBe(value);
    }
    expect(() => createConfig({ client: { version: '7.0.45.1' }, name: 'Realm', expansion: 'latest' })).toThrow(
      'Unknown expansion'
    );
  });

  test('allows only valid zones in the server regions', () => {
    expect(isAcceptedTimezone('Europe/Amsterdam')).toBe(true);
    for (const zone of ['UTC', 'Etc/GMT', 'US/Eastern', 'Europe/Invalid', 'invalid']) {
      expect(isAcceptedTimezone(zone)).toBe(false);
    }
    expect(() => createConfig({ client: { version: '7.0.45.1' }, name: 'Realm', timezone: 'UTC' })).toThrow(
      'Unsupported timezone'
    );
  });

  test('provides a sorted, unique autocomplete list containing the default', () => {
    const zones = timezoneOptions();
    expect(zones).toEqual([...new Set(zones)].sort());
    expect(zones).toContain(defaultTimezone());
    expect(zones).toContain('Europe/London');
    expect(zones.every(isAcceptedTimezone)).toBe(true);
  });
});

test('contact answers reject malformed values and config-line injection', () => {
  for (const adminEmail of ['invalid', 'owner@example.com\nServName=changed', 'owner//comment@example.com'])
    expect(() => createConfig({ client: { version: '7.0.45.1' }, adminEmail })).toThrow();
  for (const url of [
    'invalid',
    'https://example.com\nName=changed',
    'ftp://example.com',
    'https://user:pass@example.com'
  ])
    expect(() => createConfig({ client: { version: '7.0.45.1' }, url })).toThrow();
  expect(() =>
    createConfig({ client: { version: '7.0.45.1' }, emulator: 'sphere', url: 'https://example.com' })
  ).toThrow('omit');
  expect(
    createConfig({ client: { version: '7.0.45.1' }, adminEmail: 'gemwright@example.com', url: 'www.example.com' }).url
  ).toBe('www.example.com');
});

test('ai.debug is a boolean and defaults to off', () => {
  expect(createConfig({ client: { version: '7.0.45.1' }, emulator: 'servuo', ai: { debug: true } }).ai?.debug).toBe(
    true
  );
  expect(
    createConfig({ client: { version: '7.0.45.1' }, emulator: 'servuo', ai: { population: 10 } }).ai?.debug
  ).toBeUndefined();
  expect(() =>
    createConfig({
      client: { version: '7.0.45.1' },
      emulator: 'servuo',
      ai: { debug: 'yes' } as unknown as { debug: boolean }
    })
  ).toThrow('Invalid ai settings');
});
