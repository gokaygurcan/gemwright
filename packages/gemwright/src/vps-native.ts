import { createHash } from 'node:crypto';
import { cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetPath } from './assets';
import type { ShardConfig } from './config';
import type { VpsOptions } from './vps-deploy';

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function nativePackages(config: ShardConfig, client = false) {
  const packages = ['ca-certificates', 'tzdata'];
  switch (config.emulator) {
    case 'servuo':
      packages.push('dotnet-sdk-10.0', 'mono-devel', 'libgdiplus', 'zlib1g-dev');
      break;
    case 'runuo':
      packages.push('mono-devel', 'libgdiplus', 'zlib1g');
      break;
    case 'modernuo':
      packages.push('dotnet-sdk-10.0', 'libdeflate0', 'libargon2-1');
      break;
    case 'sphere':
      packages.push('g++', 'gcc', 'make', 'libmysqlclient-dev');
      break;
    case 'sphere-x':
      packages.push('g++', 'gcc', 'cmake', 'ninja-build', 'git', 'libmariadb-dev');
      break;
  }
  if (config.sphere?.mysql) packages.push('mysql-server');
  if (client) packages.push('curl', 'unzip');
  return packages;
}

export async function writeNativeBundle(root: string, config: ShardConfig, options: VpsOptions) {
  const suffix = createHash('sha256').update(config.id).digest('hex').slice(0, 16);
  const env: Record<string, string> = {
    GEMWRIGHT_ID: config.id,
    GEMWRIGHT_EMULATOR: config.emulator,
    GEMWRIGHT_PUBLIC_HOST: options.publicHost ?? '',
    TZ: config.timezone,
    SERVER_NAME: config.name,
    UO_CLIENT_VERSION: process.env.UO_CLIENT_VERSION ?? '7.0.45.1',
    UO_ENCRYPTION: process.env.UO_ENCRYPTION ?? '0',
    PUBLIC_ORIGIN: options.client ? `https://${options.domain}` : '',
    GEMWRIGHT_WEB: options.client ? '1' : '0',
    GEMWRIGHT_MYSQL: config.sphere?.mysql ? '1' : '0',
    GEMWRIGHT_PACKAGES: nativePackages(config, options.client).join(' '),
    MYSQLHOST: '127.0.0.1',
    MYSQLPORT: '3306',
    MYSQLUSER: `gw_${suffix}`,
    MYSQLDATABASE: `gw_${suffix}`
  };
  await writeFile(
    join(root, 'native.env'),
    Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}\n`)
      .join(''),
    { mode: 0o600 }
  );
  for (const name of ['install-native.sh', 'start-native.sh', 'start-web.sh', 'start-caddy.sh'])
    await cp(assetPath(`templates/vps/${name}`), join(root, name));
  const wrapper = ['sphere', 'sphere-x'].includes(config.emulator)
    ? 'sphere'
    : config.emulator === 'servuo'
      ? 'servuo'
      : 'dotnet';
  await cp(assetPath(`templates/${wrapper}/start.sh`), join(root, 'run-server.sh'));
  if (options.client)
    await writeFile(join(root, 'Caddyfile'), `${options.domain} {\n    reverse_proxy 127.0.0.1:3000\n}\n`);
}
