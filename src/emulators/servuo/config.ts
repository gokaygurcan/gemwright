import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmulatorSource, Expansion, ShardConfig } from '../../config';
import { command } from '../../process';
import { validateOwner, validateOwnerPassword } from '../accounts';

export interface ServuoSettings {
  clientFiles?: string;
  autoCreateAccounts: boolean;
  owner: string;
  accountsPerIp?: number;
  globalChat?: boolean;
  allowedClients?: string[];
}

export async function fetchServuoConfig(source: EmulatorSource): Promise<Record<string, string>> {
  if (!/^[a-f0-9]{40}$/.test(source.revision)) throw new Error('Invalid ServUO source revision.');
  const temporary = await mkdtemp(join(tmpdir(), 'gemwright-config-'));
  try {
    const response = await fetch(`https://codeload.github.com/ServUO/ServUO/tar.gz/${source.revision}`, {
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Could not fetch ServUO config: HTTP ${response.status}`);
    const archive = join(temporary, 'source.tar.gz');
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    await command(
      ['tar', '-xzf', archive, '-C', temporary, '--strip-components=1', `ServUO-${source.revision}/Config`],
      temporary
    );
    const files: Record<string, string> = {};
    for (const entry of await readdir(join(temporary, 'Config'), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Unsupported entry in upstream Config: ${entry.name}`);
      files[`Config/${entry.name}`] = await readFile(join(temporary, 'Config', entry.name), 'utf8');
    }
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function configValue(text: string, key: string): string | undefined {
  return text
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();
}

export function setConfigValue(text: string, key: string, value: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let found = false;
  const lines = text.split(/\r?\n/).map((line) => {
    if (line.startsWith(`${key}=`) || line.startsWith(`@${key}=`) || line.startsWith(`#${key}=`)) {
      if (found) throw new Error(`Duplicate upstream config key: ${key}`);
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) throw new Error(`Upstream ServUO config key is missing: ${key}. No files were written.`);
  return lines.join(newline);
}

const expansionNames: Record<Expansion, string> = {
  base: 'None',
  t2a: 'T2A',
  uor: 'UOR',
  td: 'UOTD',
  lbr: 'LBR',
  aos: 'AOS',
  se: 'SE',
  ml: 'ML',
  sa: 'SA',
  hs: 'HS',
  tol: 'TOL',
  ej: 'EJ'
};

export function prepareServuoFiles(
  upstream: Record<string, string>,
  config: ShardConfig,
  settings: ServuoSettings,
  password: string
): Record<string, string> {
  for (const filename of ['Server', 'Expansion', 'Accounts', 'DataPath']) {
    if (typeof upstream[`Config/${filename}.cfg`] !== 'string')
      throw new Error(`Missing upstream Config/${filename}.cfg`);
  }
  if (validateOwner(settings.owner)) throw new Error(validateOwner(settings.owner));
  if (!password || validateOwnerPassword(password)) throw new Error('Invalid owner password.');
  const files = { ...upstream };
  if (config.adminEmail !== undefined)
    files['Config/General.cfg'] = setConfigValue(files['Config/General.cfg'] ?? '', 'SupportEmail', config.adminEmail);
  if (config.url !== undefined)
    files['Config/General.cfg'] = setConfigValue(files['Config/General.cfg'] ?? '', 'SupportWebsite', config.url);
  files['Config/Server.cfg'] = setConfigValue(files['Config/Server.cfg']!, 'Name', config.name);
  files['Config/Expansion.cfg'] = setConfigValue(
    files['Config/Expansion.cfg']!,
    'CurrentExpansion',
    expansionNames[config.expansion]
  );
  files['Config/DataPath.cfg'] = setConfigValue(
    files['Config/DataPath.cfg']!,
    'CustomPath',
    settings.clientFiles ?? 'data/client'
  );
  if (settings.accountsPerIp !== undefined) {
    if (!Number.isInteger(settings.accountsPerIp) || settings.accountsPerIp < 0 || settings.accountsPerIp > 2147483647)
      throw new Error('Accounts per IP must be a whole number between 0 and 2147483647.');
    files['Config/Accounts.cfg'] = setConfigValue(
      files['Config/Accounts.cfg']!,
      'AccountsPerIp',
      String(settings.accountsPerIp)
    );
  }
  if (settings.globalChat !== undefined)
    files['Config/Chat.cfg'] = setConfigValue(files['Config/Chat.cfg'] ?? '', 'Enabled', String(settings.globalChat));
  if (settings.allowedClients !== undefined) {
    const keys = ['AllowRegular', 'AllowUOTD', 'AllowGod', 'AllowEC'];
    if (!settings.allowedClients.length || settings.allowedClients.some((key) => !keys.includes(key)))
      throw new Error('Choose at least one supported client.');
    for (const key of keys)
      files['Config/Client.cfg'] = setConfigValue(
        files['Config/Client.cfg'] ?? '',
        key,
        String(settings.allowedClients.includes(key))
      );
  }
  files['Config/Accounts.cfg'] = setConfigValue(
    files['Config/Accounts.cfg']!,
    'AutoCreateAccounts',
    settings.autoCreateAccounts ? 'True' : 'False'
  );

  // Match ServUO's ASCII hash input and BitConverter.ToString output.
  const protection = configValue(files['Config/Accounts.cfg']!, 'ProtectPasswords');
  const hashes: Record<string, { algorithm: string; element: string; input: string }> = {
    Crypt: { algorithm: 'md5', element: 'cryptPassword', input: password },
    NewCrypt: { algorithm: 'sha1', element: 'newCryptPassword', input: settings.owner + password },
    NewSecureCrypt: { algorithm: 'sha512', element: 'newSecureCryptPassword', input: settings.owner + password }
  };
  const hash = protection ? hashes[protection] : undefined;
  if (!hash) throw new Error(`Unsupported upstream password protection: ${protection}. No files were written.`);
  const digest = createHash(hash.algorithm)
    .update(hash.input, 'ascii')
    .digest('hex')
    .toUpperCase()
    .match(/../g)!
    .join('-');
  files['Saves/Accounts/accounts.xml'] =
    `<?xml version="1.0" encoding="utf-8"?>\n<accounts count="1">\n  <account>\n    <username>${settings.owner}</username>\n    <${hash.element}>${digest}</${hash.element}>\n    <accessLevel>Owner</accessLevel>\n  </account>\n</accounts>\n`;
  files['.gitignore'] = 'Saves/\nBackups/\nLogs/\ndata/client/\n.gemwright/\n';
  return files;
}
