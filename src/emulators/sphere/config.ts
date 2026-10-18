import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type EmulatorSource, type Expansion, type ShardConfig, validateName } from '../../config';
import type { InstanceFiles } from '../../instance';
import { command } from '../../process';
import { validateOwner, validateOwnerPassword } from '../accounts';
import { atLeast, expansionFlags, flagValue, type SphereRules, sphereNumber, validateRules } from './rules';
import { type SphereSources, sourcesFor } from './source';

export interface SphereSettings {
  scriptsSource: EmulatorSource;
  clientFiles?: string;
  autoCreateAccounts: boolean;
  owner: string;
  maps: 'expansion' | 'felucca';
  mapSize: 'modern' | 'legacy';
  clientEncryption?: 'encrypted' | 'both' | 'unencrypted';
  rules?: SphereRules;
}

export function validateSphereName(value: string): string | undefined {
  return (
    validateName(value) ??
    (/[<>/"\\[\]=]/.test(value) || value.trim() !== value
      ? 'Sphere names cannot contain < > / " \\ [ ] = or leading/trailing spaces.'
      : undefined)
  );
}

export function validateSphereOwner(value: string): string | undefined {
  return (
    validateOwner(value) ??
    (/^\d+$/.test(value) ||
    ['EOF', 'ACCOUNT', 'ADD', 'ADDMD5', 'BLOCKED', 'HELP', 'JAILED', 'UNUSED', 'UPDATE'].includes(value.toUpperCase())
      ? 'Choose a non-numeric username that is not a reserved Sphere account command.'
      : undefined)
  );
}

export async function fetchSphereFiles(sources: SphereSources): Promise<InstanceFiles> {
  const sphereSources = sourcesFor(sources.server.repository.includes('Source-X') ? 'sphere-x' : 'sphere');
  for (const kind of ['server', 'scripts'] as const) {
    const source = sources[kind];
    if (
      source.repository !== sphereSources[kind].repository ||
      source.ref !== sphereSources[kind].ref ||
      !/^[a-f0-9]{40}$/.test(source.revision)
    )
      throw new Error(`Invalid Sphere ${kind} source.`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'gemwright-sphere-config-'));
  try {
    async function extract(kind: keyof SphereSources): Promise<string> {
      const repository = sources[kind].repository.split('/').pop()!.replace('.git', '');
      const revision = sources[kind].revision;
      const response = await fetch(`https://codeload.github.com/Sphereserver/${repository}/tar.gz/${revision}`, {
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`Could not fetch Sphere ${repository}: HTTP ${response.status}`);
      const archive = join(temporary, `${kind}.tar.gz`);
      await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
      await command(['tar', '-xzf', archive, '-C', temporary], temporary);
      return join(temporary, `${repository}-${revision}`);
    }
    // Keep cleanup after both downloads finish, including when one fails.
    const results = await Promise.allSettled([extract('server'), extract('scripts')]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const [server, scripts] = results.map((result) => (result as PromiseFulfilledResult<string>).value);
    const files: InstanceFiles = {};
    for (const filename of ['sphere.ini', 'sphereCrypt.ini']) {
      files[filename] = await readFile(join(server!, 'src', filename));
    }
    async function readScripts(directory: string, prefix = 'scripts'): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await readScripts(join(directory, entry.name), filename);
        else if (entry.isFile()) files[filename] = await readFile(join(directory, entry.name));
        else throw new Error(`Unsupported Sphere script entry: ${filename}`);
      }
    }
    await readScripts(scripts!);
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function text(files: InstanceFiles, filename: string): string {
  const content = files[filename];
  if (content === undefined) throw new Error(`Missing upstream Sphere file: ${filename}`);
  return typeof content === 'string' ? content : Buffer.from(content).toString('latin1');
}

export function sphereConfigValue(ini: string, key: string): string | undefined {
  return ini
    .split(/\r?\n/)
    .map((line) => /^\s*([^/\s=]+)\s*=\s*(.*)$/.exec(line))
    .find((match) => match?.[1] === key)?.[2]
    ?.split('//')[0]
    ?.trim();
}

function setValue(ini: string, key: string, value: string): string {
  const lines = ini.split(/\r?\n/);
  let candidates = lines.flatMap((line, index) => (new RegExp(`^${key}\\s*=`).test(line) ? [index] : []));
  if (!candidates.length)
    candidates = lines.flatMap((line, index) => (new RegExp(`^//${key}\\s*=`).test(line) ? [index] : []));
  if (candidates.length !== 1)
    throw new Error(`Missing or duplicate upstream Sphere setting: ${key}. No files were written.`);
  const index = candidates[0]!;
  let comment = lines[index]!.match(/\s+\/\/.*$/)?.[0] ?? '';
  if (/^Map[01]$/.test(key) && value.startsWith('6144,')) comment = comment.replace('ML size', 'Old size');
  lines[index] = `${key}=${value}${comment}`;
  return lines.join(ini.includes('\r\n') ? '\r\n' : '\n');
}

export function sphereMapCount(expansion: Expansion): number {
  if (atLeast(expansion, 'sa')) return 6;
  if (atLeast(expansion, 'se')) return 5;
  if (atLeast(expansion, 'aos')) return 4;
  if (atLeast(expansion, 'td')) return 3;
  if (atLeast(expansion, 'uor')) return 2;
  return 1;
}

export function prepareSphereFiles(
  upstream: InstanceFiles,
  config: ShardConfig,
  settings: SphereSettings,
  password: string
): InstanceFiles {
  if (config.url?.includes('//')) throw new Error('Sphere websites must omit http(s):// and contain no //.');
  const nameError = validateSphereName(config.name);
  if (nameError) throw new Error(nameError);
  if (validateSphereOwner(settings.owner)) throw new Error(validateSphereOwner(settings.owner));
  if (!password || validateOwnerPassword(password)) throw new Error('Invalid owner password.');
  if (!['expansion', 'felucca'].includes(settings.maps) || !['modern', 'legacy'].includes(settings.mapSize))
    throw new Error('Invalid Sphere map settings.');
  if (settings.mapSize === 'legacy' && atLeast(config.expansion, 'ml'))
    throw new Error("Mondain's Legacy and later require modern map files.");
  let ini = text(upstream, 'sphere.ini');
  text(upstream, 'sphereCrypt.ini');
  const updates: Record<string, string> = {
    ServName: config.name,
    TimeZone: String(sphereTimezone(config.timezone)),
    ...(config.adminEmail !== undefined ? { AdminEmail: config.adminEmail } : {}),
    ...(config.url !== undefined ? { URL: config.url } : {}),
    ScpFiles: 'scripts/',
    WorldSave: 'save/',
    AcctFiles: 'accounts/',
    MulFiles: 'data/client/',
    Log: 'logs/',
    ...(config.emulator === 'sphere-x'
      ? { AccApp: settings.autoCreateAccounts ? '2' : '0', LocalIPAdmin: '0' }
      : { AutoAccountCreation: settings.autoCreateAccounts ? '1' : '0' }),
    Md5Passwords: '1'
  };
  if (settings.clientEncryption !== undefined) {
    if (!['encrypted', 'both', 'unencrypted'].includes(settings.clientEncryption))
      throw new Error('Invalid Sphere client encryption mode.');
    updates.UseCrypt = settings.clientEncryption === 'unencrypted' ? '0' : '1';
    updates.UseNoCrypt = settings.clientEncryption === 'encrypted' ? '0' : '1';
  }
  const optionFlags = sphereConfigValue(ini, 'OptionFlags');
  const extraFlags = sphereConfigValue(ini, 'FeatureExtra');
  if (optionFlags === undefined || extraFlags === undefined)
    throw new Error('Missing upstream Sphere option or extra feature flags.');
  Object.assign(updates, expansionFlags(config.expansion, sphereNumber(optionFlags), sphereNumber(extraFlags)));
  if (settings.rules && config.emulator === 'sphere-x')
    throw new Error('Sphere-X rules are configured in sphere.ini; classic Sphere rule presets are not supported.');
  if (settings.rules) {
    const rules = settings.rules;
    validateRules(rules);
    Object.assign(updates, {
      CombatFlags: flagValue(rules.combatFlags),
      CombatArcheryMovementDelay: String(rules.archeryMovementDelay),
      CombatDamageEra: String(rules.damageEra),
      CombatHitChanceEra: String(rules.hitChanceEra),
      CombatSpeedEra: String(rules.speedEra),
      SpeedScaleFactor: String(rules.speedScaleFactor),
      MagicFlags: flagValue(rules.magicFlags),
      RacialFlags: flagValue(rules.racialFlags),
      RevealFlags: flagValue(rules.revealFlags),
      NPCAI: flagValue(rules.npcAI)
    });
  }
  for (const [key, expansion, value] of [
    ['FeatureT2A', 't2a', '01|02'],
    ['FeatureLBR', 'lbr', '01|02'],
    ['FeatureAOS', 'aos', '01|02|04|08'],
    ['FeatureSE', 'se', '01|02'],
    ['FeatureML', 'ml', '01'],
    ['FeatureSA', 'sa', '01'],
    ['FeatureTOL', 'tol', '01']
  ] as const)
    updates[key] = atLeast(config.expansion, expansion) ? value : '0';
  const count = settings.maps === 'felucca' ? 1 : sphereMapCount(config.expansion);
  for (let map = 0; map < 6; map++) {
    const current = sphereConfigValue(ini, `Map${map}`);
    if (!current || !/^\d+,\d+,-?\d+,\d+,\d+$/.test(current)) throw new Error(`Unsupported upstream Sphere Map${map}.`);
    updates[`Map${map}`] =
      map === 5
        ? current
        : map >= count
          ? ''
          : map < 2
            ? `${settings.mapSize === 'modern' ? 7168 : 6144},4096,-1,${map},${map}`
            : current;
  }
  for (const [key, value] of Object.entries(updates)) ini = setValue(ini, key, value);
  const newline = ini.includes('\r\n') ? '\r\n' : '\n';
  const lines = ini.split(/\r?\n/);
  const servers = lines.flatMap((line, index) => (line.trim().toUpperCase() === '[SERVERS]' ? [index] : []));
  if (servers.length !== 1) throw new Error('Missing or duplicate upstream Sphere [SERVERS] section.');
  const index = servers[0]! + 1;
  if (!lines[index] || lines[index + 1] !== '127.0.0.1' || lines[index + 2] !== '2593')
    throw new Error('Unsupported upstream Sphere local server entry.');
  lines[index] = config.name;
  ini = lines.join(newline);

  let tables = text(upstream, 'scripts/spheretables.scp');
  const found = new Set<number>();
  tables = tables
    .split(/\r?\n/)
    .map((line) => {
      if (config.emulator === 'sphere-x') {
        const match = /^(\/\/)?(maps\/map([0-5])\/[^\s]+\.scp)$/.exec(line);
        if (!match) return line;
        const map = Number(match[3]);
        found.add(map);
        if (upstream[`scripts/${match[2]}`] === undefined) throw new Error(`Missing upstream map script: ${match[2]}`);
        const era = /_(se|aos|ml|sa|hs|tol)(?:_|\.)/.exec(match[2]!);
        const enabled =
          map < count &&
          (!match[2]!.includes('_aos_old_haven') || !atLeast(config.expansion, 'ml')) &&
          (!era || atLeast(config.expansion, era[1] as Expansion)) &&
          (!era || settings.mapSize === 'modern' || ['aos', 'se'].includes(era[1]!));
        return `${enabled ? '' : '//'}${match[2]}`;
      }
      const match = /^(\/\/)?(scripts\/maps\/sphere_map(?:_points)?([0-5])(?:_([a-z]+))?\.scp)$/.exec(line);
      if (!match) return line;
      const map = Number(match[3]);
      found.add(map);
      if (upstream[match[2]!] === undefined) throw new Error(`Missing upstream map script: ${match[2]}`);
      const extension = match[4];
      if (extension && !['se', 'ml', 'sa', 'hs', 'tol'].includes(extension))
        throw new Error(`Unsupported upstream Sphere map extension: ${extension}`);
      const enabled =
        map < count &&
        (!extension || atLeast(config.expansion, extension as Expansion)) &&
        (settings.mapSize === 'modern' || !extension || extension === 'se');
      return `${enabled ? '' : '//'}${match[2]}`;
    })
    .join(tables.includes('\r\n') ? '\r\n' : '\n');
  if (found.size !== 6) throw new Error('Upstream Sphere map script layout changed. No files were written.');
  const scriptUpdates: InstanceFiles = {};
  if (settings.rules?.speedEra === 4) {
    let overrides = 0;
    for (const filename of Object.keys(upstream).filter(
      (name) => name.startsWith('scripts/') && name.endsWith('.scp')
    )) {
      const original = text(upstream, filename);
      const updated = original.replace(
        /^([ \t]*)\/\/(TAG\.OVERRIDE\.SPEED=\d+[^\r\n]*)/gm,
        (_line, indentation, value) => {
          overrides++;
          return indentation + value;
        }
      );
      if (updated !== original) scriptUpdates[filename] = Buffer.from(updated, 'latin1');
    }
    if (!overrides)
      throw new Error('ML swing speed requires upstream commented weapon speed overrides. No files were written.');
  }
  const digest = createHash('md5').update(password, 'ascii').digest('hex');
  return {
    ...upstream,
    ...scriptUpdates,
    'sphere.ini': Buffer.from(ini, 'latin1'),
    'scripts/spheretables.scp': Buffer.from(tables, 'latin1'),
    'accounts/sphereaccu.scp': `[${settings.owner}]\nPLEVEL=Owner\nMD5PASSWORD=${digest}\n\n[EOF]\n`,
    'accounts/sphereacct.scp': '[EOF]\n',
    'save/.gitkeep': '',
    '.gitignore': 'accounts/\nsave/\nlogs/\ndata/client/\n.gemwright/\n'
  };
}

export function sphereTimezone(zone: string, year = new Date().getUTCFullYear()): number {
  const formatter = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' });
  const offsets = Array.from({ length: 12 }, (_, month) => {
    const label = formatter
      .formatToParts(new Date(Date.UTC(year, month, 15)))
      .find((part) => part.type === 'timeZoneName')!.value;
    if (label === 'GMT') return 0;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(label);
    if (!match) throw new Error(`Cannot determine Sphere timezone for ${zone}.`);
    return (match[1] === '+' ? 1 : -1) * (Number(match[2]) + Number(match[3] ?? 0) / 60);
  });
  // Sphere advertises whole hours west of GMT; use standard time rather than seasonal DST.
  const offset = -Math.min(...offsets);
  if (!Number.isInteger(offset))
    throw new Error(`Sphere cannot represent the fractional-hour timezone ${zone}. Choose a whole-hour zone.`);
  return offset || 0;
}
