import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Expansion, expansions } from '../game/expansions';
import { validateSchema } from './compatibility';
import type {
  AiSettings,
  DotnetSettings,
  EmulatorSource,
  ServuoSettings,
  ShardConfig,
  SphereRules,
  SphereSettings
} from './types';

export type { AiSettings, EmulatorSource, ShardConfig } from './types';

export const emulators = [
  { value: 'servuo', label: 'ServUO', disabled: false },
  { value: 'sphere', label: 'Sphere', disabled: false },
  { value: 'sphere-x', label: 'Sphere-X', disabled: false },
  { value: 'runuo', label: 'RunUO', disabled: false },
  { value: 'modernuo', label: 'ModernUO', disabled: false }
] as const;

export type Emulator = Extract<(typeof emulators)[number], { disabled: false }>['value'];

export const configFilename = 'gemwright.json';
export const defaultName = 'Gemwright';
export const defaultExpansion: Expansion = 'ej';
export const defaultEmulator: Emulator = 'servuo';

const acceptedRegions = new Set([
  'Africa',
  'America',
  'Antarctica',
  'Arctic',
  'Asia',
  'Atlantic',
  'Australia',
  'Europe',
  'Indian',
  'Pacific'
]);

export function shardId(name: string): string {
  return (name || defaultName)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateName(name: string): string | undefined {
  if (name !== '' && !/^[\x20-\x7e]{1,32}$/.test(name)) {
    return 'Use 1-32 printable ASCII characters.';
  }
}

export function isAcceptedTimezone(zone: string): boolean {
  // biome-ignore lint/style/noNonNullAssertion: zone is not empty
  if (!acceptedRegions.has(zone.split('/')[0]!)) return false;

  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function timezoneOptions(): string[] {
  const zones = Intl.supportedValuesOf('timeZone').filter(isAcceptedTimezone);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (isAcceptedTimezone(local) && !zones.includes(local)) zones.push(local);
  if (!zones.includes('Europe/London')) zones.push('Europe/London');
  return zones.sort();
}

export function defaultTimezone(): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isAcceptedTimezone(local) ? local : 'Europe/London';
}

export function createConfig(
  input: {
    schemaVersion?: 1;
    $schema?: string;
    packages?: ShardConfig['packages'];
    railway?: ShardConfig['railway'];
    connection?: ShardConfig['connection'];
    client?: ShardConfig['client'];
    name?: string;
    adminEmail?: string;
    url?: string;
    timezone?: string;
    expansion?: string;
    emulator?: string;
    source?: EmulatorSource;
    runuo?: DotnetSettings;
    modernuo?: DotnetSettings;
    servuo?: ServuoSettings;
    sphere?: SphereSettings;
    ai?: AiSettings;
  },
  validateRules: (rules: SphereRules) => void
): ShardConfig {
  const name = input.name || defaultName;
  const error = validateName(name);
  if (error) throw new Error(error);
  for (const [value, validate] of [
    [input.adminEmail, validateAdminEmail],
    [input.url, validateWebsite]
  ] as const) {
    if (value !== undefined) {
      const error = validate(value);
      if (error) throw new Error(error);
    }
  }
  const timezone = input.timezone ?? defaultTimezone();
  if (!isAcceptedTimezone(timezone)) {
    throw new Error(`Unsupported timezone: ${timezone}. Choose an IANA zone in an accepted region.`);
  }
  const expansion = input.expansion ?? defaultExpansion;
  if (!expansions.some((option) => option.value === expansion)) {
    throw new Error(`Unknown expansion: ${expansion}. Choose ${expansions.map((option) => option.value).join(', ')}.`);
  }
  const emulator = input.emulator ?? defaultEmulator;
  if (!emulators.some((option) => option.value === emulator && !option.disabled)) {
    throw new Error(`Unsupported emulator: ${emulator}. Choose servuo, sphere, sphere-x, runuo or modernuo.`);
  }
  if (
    input.source &&
    (!/^[a-f0-9]{40}$/.test(input.source.revision) || !input.source.repository || !input.source.ref)
  ) {
    throw new Error('Invalid emulator source: repository, ref and a full commit revision are required.');
  }
  if ((emulator === 'sphere' || emulator === 'sphere-x') && input.url?.includes('//'))
    throw new Error('Sphere websites must omit http(s):// and contain no //; use www.example.com.');
  if (input.sphere) {
    const settings = input.sphere;
    if (settings.rules !== undefined) validateRules(settings.rules);
    if (
      !['sphere', 'sphere-x'].includes(emulator) ||
      !settings.scriptsSource ||
      !/^[a-f0-9]{40}$/.test(settings.scriptsSource.revision) ||
      !settings.scriptsSource.repository ||
      !settings.scriptsSource.ref ||
      typeof settings.autoCreateAccounts !== 'boolean' ||
      !/^[A-Za-z0-9_-]{1,16}$/.test(settings.owner) ||
      !['expansion', 'felucca'].includes(settings.maps) ||
      !['modern', 'legacy'].includes(settings.mapSize) ||
      (settings.clientEncryption !== undefined &&
        !['encrypted', 'both', 'unencrypted'].includes(settings.clientEncryption)) ||
      (settings.mysql !== undefined && typeof settings.mysql !== 'boolean') ||
      (settings.clientFiles !== undefined && typeof settings.clientFiles !== 'string')
    )
      throw new Error('Invalid Sphere settings or scripts source.');
  }
  if (input.ai) {
    const { population, decisions, speech, races, chaos, wars, cohorts, debug } = input.ai;
    if (
      emulator !== 'servuo' ||
      (population !== undefined && (!Number.isInteger(population) || population < 0 || population > 300)) ||
      (decisions !== undefined && !['local', 'jev'].includes(decisions)) ||
      (speech !== undefined && !['authored', 'claude'].includes(speech)) ||
      (chaos !== undefined && (typeof chaos !== 'number' || !(chaos >= 0 && chaos <= 1))) ||
      (wars !== undefined && typeof wars !== 'boolean') ||
      (debug !== undefined && typeof debug !== 'boolean') ||
      (cohorts !== undefined &&
        (typeof cohorts !== 'object' ||
          cohorts === null ||
          Object.values(cohorts).some(
            (c) =>
              !Number.isInteger(c?.count) ||
              c.count < 0 ||
              typeof c.professions !== 'object' ||
              c.professions === null ||
              Object.values(c.professions).some((w) => typeof w !== 'number' || !(w >= 0))
          ))) ||
      (races !== undefined &&
        (!Array.isArray(races) || !races.length || races.some((r) => !['human', 'elf', 'gargoyle'].includes(r))))
    )
      throw new Error(
        'Invalid ai settings: ServUO only, population 0-300, decisions local or jev, speech authored or claude, races human, elf or gargoyle, chaos 0-1, wars true or false, debug true or false, cohorts { city: { count, professions: { id: weight } } }.'
      );
    // Elves arrive with Mondain's Legacy, gargoyles with Stygian Abyss.
    const era = expansions.findIndex((option) => option.value === expansion);
    const since = { human: 'base', elf: 'ml', gargoyle: 'sa' } as const;
    const unavailable = (races ?? []).filter(
      (race) => era < expansions.findIndex((option) => option.value === since[race])
    );
    if (unavailable.length)
      throw new Error(
        `ai.races lists ${unavailable.join(', ')}, which the ${expansion} expansion does not have (elves need ml, gargoyles sa).`
      );
  }
  for (const key of ['runuo', 'modernuo'] as const) {
    const settings = input[key];
    if (
      settings &&
      (emulator !== key ||
        !/^[A-Za-z0-9_-]{1,16}$/.test(settings.owner) ||
        typeof settings.autoCreateAccounts !== 'boolean' ||
        (settings.clientFiles !== undefined && typeof settings.clientFiles !== 'string'))
    )
      throw new Error(`Invalid ${key} settings.`);
  }
  if (input.client) clientVersion(input);
  return {
    ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
    ...(input.$schema ? { $schema: input.$schema } : {}),
    ...(input.packages ? { packages: { ...input.packages } } : {}),
    ...(input.railway ? { railway: { ...input.railway } } : {}),
    ...(input.connection ? { connection: { ...input.connection } } : {}),
    ...(input.client ? { client: { ...input.client } } : {}),
    ...(input.runuo ? { runuo: { ...input.runuo } } : {}),
    ...(input.modernuo ? { modernuo: { ...input.modernuo } } : {}),
    ...(input.servuo ? { servuo: { ...input.servuo } } : {}),
    ...(input.sphere
      ? {
          sphere: {
            ...input.sphere,
            ...(input.sphere.rules ? { rules: { ...input.sphere.rules } } : {}),
            scriptsSource: { ...input.sphere.scriptsSource }
          }
        }
      : {}),
    ...(input.source ? { source: { ...input.source } } : {}),
    ...(input.ai ? { ai: { ...input.ai } } : {}),
    ...(input.adminEmail !== undefined ? { adminEmail: input.adminEmail } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    name,
    id: shardId(name),
    timezone,
    expansion: expansion as Expansion,
    emulator: emulator as Emulator
  };
}

export const defaultAdminEmail = 'gemwright@example.com';
export const defaultWebsite = 'www.example.com';

export function validateAdminEmail(value: string): string | undefined {
  if (
    !/^[A-Za-z0-9.!#$%&'*+?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) ||
    value.includes('//')
  )
    return 'Enter an email address, such as gemwright@example.com.';
}

export function validateWebsite(value: string): string | undefined {
  if (!/^[\x21-\x7e]+$/.test(value) || /["<>\\]/.test(value))
    return 'Enter a website address without spaces, quotes or backslashes.';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password)
      throw new Error();
  } catch {
    return 'Enter an HTTP(S) website or hostname, such as www.example.com.';
  }
}

export async function loadShard(directory: string, validateRules: (rules: SphereRules) => void): Promise<ShardConfig> {
  let input: ShardConfig;
  try {
    input = JSON.parse(await readFile(join(directory, configFilename), 'utf8'));
  } catch {
    throw new Error(`Cannot read ${configFilename}. Run gemwright init in the shard directory first.`);
  }
  validateSchema(input);
  for (const key of ['name', 'id', 'timezone', 'expansion', 'emulator'] as const) {
    if (typeof input[key] !== 'string') throw new Error(`Invalid ${configFilename}: missing ${key}.`);
  }
  const config = createConfig(input, validateRules);
  if (config.id !== input.id || !config.id)
    throw new Error('The recorded shard ID must be a non-empty slug derived from its name.');
  return config;
}

// The classic client players use (gemwright.json client.version): residents log in as it and the web
// client is built for it. Required; there is no built-in version to fall back on.
export function clientVersion(config: Pick<ShardConfig, 'client'>): string {
  const version = config.client?.version;
  if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version))
    throw new Error('Set client.version in gemwright.json (the classic client version players use, e.g. 7.0.45.1).');
  return version;
}
