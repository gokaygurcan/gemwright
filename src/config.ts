import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DotnetSettings } from './emulators/dotnet/init';
import type { ServuoSettings } from './emulators/servuo/config';
import type { SphereSettings } from './emulators/sphere/config';
import { validateRules } from './emulators/sphere/rules';

export const expansions = [
  { value: 'base', label: 'Base' },
  { value: 't2a', label: 'The Second Age' },
  { value: 'uor', label: 'Renaissance' },
  { value: 'td', label: 'Third Dawn' },
  { value: 'lbr', label: "Lord Blackthorn's Revenge" },
  { value: 'aos', label: 'Age of Shadows' },
  { value: 'se', label: 'Samurai Empire' },
  { value: 'ml', label: "Mondain's Legacy" },
  { value: 'sa', label: 'Stygian Abyss' },
  { value: 'hs', label: 'High Seas' },
  { value: 'tol', label: 'Time of Legends' },
  { value: 'ej', label: 'Endless Journey' }
] as const;

export type Expansion = (typeof expansions)[number]['value'];

export const emulators = [
  { value: 'servuo', label: 'ServUO', disabled: false },
  { value: 'sphere', label: 'Sphere', disabled: false },
  { value: 'sphere-x', label: 'Sphere-X', disabled: false },
  { value: 'runuo', label: 'RunUO', disabled: false },
  { value: 'modernuo', label: 'ModernUO', disabled: false }
] as const;

export type Emulator = Extract<(typeof emulators)[number], { disabled: false }>['value'];

export interface EmulatorSource {
  repository: string;
  ref: string;
  revision: string;
}

export interface ShardConfig {
  name: string;
  adminEmail?: string;
  url?: string;
  id: string;
  timezone: string;
  expansion: Expansion;
  emulator: Emulator;
  source?: EmulatorSource;
  runuo?: DotnetSettings;
  modernuo?: DotnetSettings;
  servuo?: ServuoSettings;
  sphere?: SphereSettings;
  ai?: AiSettings;
}

// AI residents (gemwright deploy --ai): how many, and whether Jev or the local rules decide.
export interface AiSettings {
  population?: number;
  decisions?: 'local' | 'jev';
  // Replies in each resident's own voice by Claude Haiku 5.5, guarded; authored lines otherwise.
  speech?: 'authored' | 'claude';
  // Races new residents are created as; human and elf by default (gargoyles need their own gear).
  races?: ('human' | 'elf' | 'gargoyle')[];
}

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

export function createConfig(input: {
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
}): ShardConfig {
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
    const { population, decisions, speech, races } = input.ai;
    if (
      emulator !== 'servuo' ||
      (population !== undefined && (!Number.isInteger(population) || population < 0 || population > 250)) ||
      (decisions !== undefined && !['local', 'jev'].includes(decisions)) ||
      (speech !== undefined && !['authored', 'claude'].includes(speech)) ||
      (races !== undefined &&
        (!Array.isArray(races) || !races.length || races.some((r) => !['human', 'elf', 'gargoyle'].includes(r))))
    )
      throw new Error(
        'Invalid ai settings: ServUO only, population 0-250, decisions local or jev, speech authored or claude, races human, elf or gargoyle.'
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
  return {
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

export async function loadShard(directory: string): Promise<ShardConfig> {
  let input: ShardConfig;
  try {
    input = JSON.parse(await readFile(join(directory, configFilename), 'utf8'));
  } catch {
    throw new Error(`Cannot read ${configFilename}. Run gemwright init in the shard directory first.`);
  }
  for (const key of ['name', 'id', 'timezone', 'expansion', 'emulator'] as const) {
    if (typeof input[key] !== 'string') throw new Error(`Invalid ${configFilename}: missing ${key}.`);
  }
  const config = createConfig(input);
  if (config.id !== input.id || !config.id)
    throw new Error('The recorded shard ID must be a non-empty slug derived from its name.');
  return config;
}
