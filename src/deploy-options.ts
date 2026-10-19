import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import { loadShard } from './config';
import { answer, Cancelled } from './prompts';
import { type VpsOptions, validateVpsOptions } from './vps-deploy';

export interface DeployOptions extends VpsOptions {
  target?: string;
  ssh?: string;
  remotePath?: string;
  yes?: boolean;
}

export function validateSshDestination(value: string) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(value))
    throw new Error('Use an SSH config alias or user@hostname for --ssh.');
}

export function validateRemotePath(value: string) {
  if (!/^[a-zA-Z0-9_/.~-]+$/.test(value) || value.split('/').includes('..') || ['/', '.', '~'].includes(value))
    throw new Error('Use a dedicated remote directory without spaces or .. segments.');
  if (value.includes('~')) throw new Error('Use a path relative to the SSH home directory, or an absolute path.');
}

export async function deploymentOptions(
  input: DeployOptions,
  directory = process.cwd(),
  interactive = !!process.stdin.isTTY
): Promise<DeployOptions> {
  const options = { ...input };
  if (options.target && !['railway', 'vps'].includes(options.target))
    throw new Error('Deployment target must be railway or vps.');
  const ask = interactive && !options.yes;
  let saved: DeployOptions = {};
  if (ask) {
    saved = await readFile(join(directory, '.gemwright/deployment.json'), 'utf8').then(JSON.parse, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    });
    prompts.intro('Deploy your shard');
  }
  options.target ??= ask
    ? answer(
        await prompts.select({
          message: 'Where should this shard run?',
          initialValue: saved.target ?? 'railway',
          options: [
            { value: 'railway', label: 'Railway' },
            { value: 'vps', label: 'VPS / your own Linux server' }
          ]
        })
      )
    : 'railway';
  if (options.target !== 'vps') {
    if (
      options.publicHost ||
      options.domain ||
      options.prepare ||
      options.ssh ||
      options.remotePath ||
      options.installDeps ||
      options.method
    )
      throw new Error(
        '--public-host, --domain, --prepare, --ssh, --remote-path and --install-deps require --target vps.'
      );
    return options;
  }
  const config = await loadShard(directory);
  options.method ??= ask
    ? answer(
        await prompts.select({
          message: 'How should the VPS run this shard?',
          initialValue: saved.method ?? 'docker',
          options: [
            { value: 'docker', label: 'Docker Compose', hint: 'containers with persistent data' },
            { value: 'native', label: 'Native systemd', hint: 'Ubuntu only; installs host packages and services' }
          ]
        })
      )
    : 'docker';
  if (ask && !options.prepare && !options.ssh) {
    const location = answer(
      await prompts.select({
        message: 'How should Gemwright deploy to the VPS?',
        initialValue: 'ssh',
        options: [
          { value: 'ssh', label: 'Connect over SSH from this computer' },
          { value: 'local', label: 'Run on this machine (already on the VPS)' },
          { value: 'prepare', label: 'Prepare a bundle for manual deployment' }
        ]
      })
    );
    options.prepare = location === 'prepare';
    if (location === 'ssh')
      options.ssh = answer(
        await prompts.text({
          message: 'SSH destination (config alias or user@hostname)',
          defaultValue: saved.ssh,
          placeholder: 'my-vps',
          validate(value) {
            try {
              validateSshDestination(value ?? '');
            } catch (error) {
              return (error as Error).message;
            }
          }
        })
      );
  }
  if (options.ssh) {
    validateSshDestination(options.ssh);
    options.remotePath ??= ask
      ? answer(
          await prompts.text({
            message: 'Deployment directory on the VPS (relative to the SSH home directory, or absolute)',
            defaultValue: saved.remotePath ?? `gemwright/${config.id}`,
            validate(value) {
              try {
                validateRemotePath(value ?? '');
              } catch (error) {
                return (error as Error).message;
              }
            }
          })
        )
      : `gemwright/${config.id}`;
    validateRemotePath(options.remotePath);
  } else if (options.remotePath) throw new Error('--remote-path requires --ssh.');
  if (!options.publicHost && ask)
    options.publicHost = answer(
      await prompts.text({
        message: 'Public IPv4 address or login hostname',
        defaultValue: saved.publicHost,
        validate(value) {
          try {
            validateVpsOptions({ publicHost: value });
          } catch (error) {
            return (error as Error).message;
          }
        }
      })
    );
  if (options.client === undefined && ask)
    options.client = answer(
      await prompts.confirm({
        message: 'Deploy the browser client too? You can add it later.',
        initialValue: saved.client ?? false
      })
    );
  if (options.client && !options.domain && ask)
    options.domain = answer(
      await prompts.text({
        message: 'Browser client domain (DNS must point to the VPS)',
        defaultValue: saved.domain,
        validate(value) {
          try {
            validateVpsOptions({ publicHost: options.publicHost, client: true, domain: value });
          } catch (error) {
            return (error as Error).message;
          }
        }
      })
    );
  options.files ??= (config.emulator === 'sphere-x' ? config.sphere : config[config.emulator])?.clientFiles;
  if (!options.files && ask)
    options.files = answer(
      await prompts.text({
        message: 'Local UO game files directory',
        defaultValue: saved.files,
        async validate(value) {
          if (!value || !(await stat(resolve(directory, value)).catch(() => undefined))?.isDirectory())
            return 'Choose an existing game files directory.';
        }
      })
    );
  validateVpsOptions(options);
  if (!options.files) throw new Error('VPS deployment requires --files <path> or clientFiles in gemwright.json.');
  if (ask) {
    prompts.note(
      `Target: ${options.ssh ?? (options.prepare ? 'manual bundle' : 'this machine')}\n` +
        `Public login: ${options.publicHost}:2593\n` +
        `Browser client: ${options.client ? `https://${options.domain}` : 'not deployed'}\n` +
        `Runtime: ${options.method === 'native' ? 'native systemd (Ubuntu only)' : 'Docker Compose'}. Automatic package installation supports Ubuntu only and requires approval; sudo may be required.`,
      'Deployment plan'
    );
    if (!answer(await prompts.confirm({ message: 'Continue with this deployment?', initialValue: true })))
      throw new Cancelled();
  }
  return options;
}
