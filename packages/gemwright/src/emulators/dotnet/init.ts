import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expansions } from '@gemwright/common/expansions';

import * as prompts from '@clack/prompts';

import type { ShardConfig } from '../../config';
import type { InstanceFiles } from '../../instance';
import { answer } from '../../prompts';
import { generatedOwnerPassword, ownerAccountXml, validateOwner, validateOwnerPassword } from '../accounts';
import { checkoutSource } from '../source';
import { type DotnetEmulator, dotnetSources } from './source';

export interface DotnetSettings {
  clientFiles?: string;
  owner: string;
  autoCreateAccounts: boolean;
}

export async function fetchDotnetFiles(config: ShardConfig): Promise<InstanceFiles> {
  const emulator = config.emulator as DotnetEmulator;
  const expected = dotnetSources[emulator];
  if (!expected || config.source?.repository !== expected.repository || config.source.ref !== expected.ref)
    throw new Error('Missing or unsupported emulator source.');
  const temporary = await mkdtemp(join(tmpdir(), 'gemwright-config-'));
  try {
    await checkoutSource(temporary, config.source);
    const files: InstanceFiles = {};
    async function readTree(path: string) {
      for (const entry of await readdir(join(temporary, path), { withFileTypes: true })) {
        const filename = `${path}/${entry.name}`;
        if (entry.isDirectory()) await readTree(filename);
        else if (entry.isFile()) files[filename] = await readFile(join(temporary, filename));
        else throw new Error(`Unsupported source entry: ${filename}`);
      }
    }
    for (const folder of emulator === 'runuo' ? ['Scripts', 'Data'] : ['Projects/UOContent', 'Distribution/Data'])
      await readTree(folder);
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function prepareDotnetFiles(
  upstream: InstanceFiles,
  config: ShardConfig,
  settings: DotnetSettings,
  password: string
): InstanceFiles {
  if (validateOwner(settings.owner) || !password || validateOwnerPassword(password))
    throw new Error('Invalid owner credentials.');
  const files = { ...upstream };
  const read = (name: string) => {
    const value = files[name];
    if (value === undefined) throw new Error(`Missing upstream ${name}.`);
    return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  };
  function replace(name: string, before: string | RegExp, after: string) {
    const original = read(name);
    const updated = original.replace(before, () => after);
    if (updated === original) throw new Error(`Unsupported upstream setting in ${name}.`);
    files[name] = updated;
  }
  if (config.emulator === 'runuo') {
    replace(
      'Scripts/Misc/ServerList.cs',
      'public static readonly string ServerName = "RunUO TC";',
      `public static readonly string ServerName = ${JSON.stringify(config.name)};`
    );
    replace(
      'Scripts/Misc/ServerList.cs',
      'public static readonly bool AutoDetect = true;',
      'public static readonly bool AutoDetect = false;'
    );
    replace(
      'Scripts/Misc/DataPath.cs',
      'private static string CustomPath = null;',
      'private static string CustomPath = "data/client";'
    );
    const era =
      config.expansion === 'base'
        ? 'None'
        : config.expansion === 'td'
          ? 'UOTD'
          : config.expansion === 'ej'
            ? 'TOL'
            : config.expansion.toUpperCase();
    replace(
      'Scripts/Misc/CurrentExpansion.cs',
      'private static readonly Expansion Expansion = Expansion.TOL;',
      `private static readonly Expansion Expansion = Expansion.${era};\n`
    );
    replace(
      'Scripts/Accounting/AccountHandler.cs',
      'private static bool AutoAccountCreation = true;',
      `private static bool AutoAccountCreation = ${settings.autoCreateAccounts};\n`
    );
  } else {
    const index = expansions.findIndex((entry) => entry.value === config.expansion);
    const eras = JSON.parse(read('Distribution/Data/expansions.json')) as { Id: number }[];
    const era = eras.find((entry) => entry.Id === index);
    if (!era) throw new Error('Unsupported ModernUO expansion data.');
    files['Configuration/expansion.json'] = `${JSON.stringify(era, null, 2)}\n`;
    files['Configuration/modernuo.json'] = `${JSON.stringify(
      {
        assemblyDirectories: ['Assemblies'],
        dataDirectories: ['data/client'],
        listeners: ['0.0.0.0:2593'],
        settings: {
          'serverListing.serverName': config.name,
          'serverListing.autoDetect': 'False',
          'accountHandler.enableAutoAccountCreation': String(settings.autoCreateAccounts),
          'world.savePath': 'Saves',
          'world.tempSavePath': 'temp',
          'pathfinding.prebakeMaps': 'False'
        }
      },
      null,
      2
    )}\n`;
  }
  files['Saves/Accounts/accounts.xml'] = ownerAccountXml(settings.owner, password, 'sha1', 'newCryptPassword');
  files['.gitignore'] = 'Saves/\nBackups/\nLogs/\ntemp/\ndata/client/\n.gemwright/\n';
  return files;
}

export async function initializeDotnet(config: ShardConfig, yes = false, loadFiles = fetchDotnetFiles) {
  const upstream = await loadFiles(config);
  const clientFiles = yes
    ? ''
    : answer(
        await prompts.text({
          message: 'UO client files directory (optional; leave blank to add at deploy)',
          validate: async (value) => {
            if (!value) return;
            if (!(await stat(resolve(value)).catch(() => undefined))?.isDirectory())
              return 'Choose an existing directory.';
          }
        })
      );
  const autoCreateAccounts = yes
    ? true
    : answer(
        await prompts.confirm({ message: 'Allow players to create accounts on first login?', initialValue: true })
      );
  const owner = yes
    ? 'admin'
    : answer(
        await prompts.text({
          message: 'Owner username',
          defaultValue: 'admin',
          placeholder: 'admin',
          validate: (value) => validateOwner(value || 'admin')
        })
      );
  let password = yes
    ? ''
    : answer(
        await prompts.password({
          message: 'Owner password (leave blank to generate)',
          validate: (value) => validateOwnerPassword(value ?? '')
        })
      );
  const generatedPassword = password ? undefined : generatedOwnerPassword();
  password ||= generatedPassword ?? '';
  const settings: DotnetSettings = {
    owner,
    autoCreateAccounts,
    ...(clientFiles ? { clientFiles: resolve(clientFiles) } : {})
  };
  return { settings, files: prepareDotnetFiles(upstream, config, settings, password), generatedPassword };
}
