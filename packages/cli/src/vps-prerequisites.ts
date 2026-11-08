import { readFile } from 'node:fs/promises';

import { attachedCommand, command } from '@gemwright/deployment/process';

import * as prompts from '@clack/prompts';

import { answer } from './prompts';
import type { VpsOptions } from './vps-deploy';

// Docker on this machine, installed on approval (Ubuntu only), and whether it needs sudo.
export async function localPrerequisites(options: VpsOptions & { yes?: boolean }, directory: string) {
  const ready = await command(['docker', 'compose', 'version'], directory).then(
    () => true,
    () => false
  );
  const packages = ['docker.io', 'docker-compose-v2'];
  let install = options.installDeps ?? false;
  if (!ready && !install && process.stdin.isTTY && !options.yes)
    install = answer(
      await prompts.confirm({
        message: `Install missing packages: ${packages.join(', ')}? This requires sudo.`,
        initialValue: false
      })
    );
  if (!ready && !install)
    throw new Error(
      `Missing VPS packages: ${packages.join(', ')}. Approve installation interactively or pass --install-deps.`
    );
  const sudo = process.getuid?.() === 0 ? [] : ['sudo'];
  if (!ready) {
    if (!/^ID=ubuntu$/m.test(await readFile('/etc/os-release', 'utf8')))
      throw new Error('Automatic package installation currently supports Ubuntu.');
    await attachedCommand([...sudo, 'apt-get', 'update'], directory);
    await attachedCommand([...sudo, 'apt-get', 'install', '-y', ...packages], directory);
    await attachedCommand([...sudo, 'systemctl', 'enable', '--now', 'docker'], directory);
  }
  const access = await command(['docker', 'info'], directory).then(
    () => true,
    () => false
  );
  return { sudo: access ? [] : sudo };
}
