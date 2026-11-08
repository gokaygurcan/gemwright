import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadShard } from '@gemwright/server/config';

import * as prompts from '@clack/prompts';

import { answer, Cancelled } from './prompts';
import { type VpsOptions, validateVpsOptions } from './vps-deploy';

export interface DeployOptions extends VpsOptions {
  ssh?: string;
  sshPort?: number;
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
  const ask = interactive && !options.yes;
  if (ask) prompts.intro('Deploy your shard to a VPS');
  const config = await loadShard(directory);
  const { vps } = config;
  options.ssh ??= vps?.ssh;
  options.sshPort ??= vps?.port;
  options.publicHost ??= vps?.publicHost;
  if (options.client) options.domain ??= vps?.domain;
  if (options.ssh) options.remotePath ??= vps?.path;
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
            defaultValue: `gemwright/${config.id}`,
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
        initialValue: false
      })
    );
  if (options.client && !options.domain && ask)
    options.domain = answer(
      await prompts.text({
        message: 'Browser client domain (DNS must point to the VPS)',
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
        'Runtime: Docker Compose. Automatic package installation supports Ubuntu only and requires approval; sudo may be required.',
      'Deployment plan'
    );
    if (!answer(await prompts.confirm({ message: 'Continue with this deployment?', initialValue: true })))
      throw new Cancelled();
  }
  return options;
}
