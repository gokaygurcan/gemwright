import { readFile } from 'node:fs/promises';

import * as prompts from '@clack/prompts';

import type { ShardConfig } from './config';
import { attachedCommand, command } from './process';
import { answer } from './prompts';
import type { VpsOptions } from './vps-deploy';
import { nativePackages, shellQuote } from './vps-native';

export async function localPrerequisites(
  options: VpsOptions & { yes?: boolean },
  config: ShardConfig,
  directory: string
) {
  const native = options.method === 'native';
  const ubuntu = /^ID=ubuntu$/m.test(await readFile('/etc/os-release', 'utf8'));
  if (native && !ubuntu) throw new Error('Native deployment currently requires Ubuntu with systemd.');
  const dockerReady =
    !native &&
    (await command(['docker', 'compose', 'version'], directory).then(
      () => true,
      () => false
    ));
  const packages = native ? nativePackages(config, options.client) : ['docker.io', 'docker-compose-v2'];
  const missing = native
    ? (
        await command(
          [
            'sh',
            '-c',
            `for package in ${packages.map(shellQuote).join(' ')}; do
if [ "$package" = dotnet-sdk-10.0 ] && command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks | grep -q '^10\\.'; then continue; fi
if [ "$(dpkg-query -W -f='\${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then echo "$package"; fi
done`
          ],
          directory
        )
      )
        .split('\n')
        .filter(Boolean)
    : dockerReady
      ? []
      : packages;
  let install = options.installDeps ?? false;
  if (missing.length && !install && process.stdin.isTTY && !options.yes)
    install = answer(
      await prompts.confirm({
        message: `Install missing packages: ${missing.join(', ')}? This requires sudo.`,
        initialValue: false
      })
    );
  if (missing.length && !install)
    throw new Error(
      `Missing VPS packages: ${missing.join(', ')}. Approve installation interactively or pass --install-deps.`
    );
  if (missing.length && install && !ubuntu)
    throw new Error('Automatic package installation currently supports Ubuntu.');
  const sudo = process.getuid?.() === 0 ? [] : ['sudo'];
  if (!native && missing.length) {
    await attachedCommand([...sudo, 'apt-get', 'update'], directory);
    await attachedCommand([...sudo, 'apt-get', 'install', '-y', ...packages], directory);
    await attachedCommand([...sudo, 'systemctl', 'enable', '--now', 'docker'], directory);
  }
  const dockerAccess =
    native ||
    (await command(['docker', 'info'], directory).then(
      () => true,
      () => false
    ));
  return { install, sudo: dockerAccess ? [] : sudo };
}
