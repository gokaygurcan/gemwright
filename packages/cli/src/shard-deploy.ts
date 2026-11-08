import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';
import { pull } from '@gemwright/deployment/pull';
import { readJson } from '@gemwright/deployment/state';
import { resolveTarget, type Target, targets, vpsRunner } from '@gemwright/deployment/target';

import * as prompts from '@clack/prompts';

import { port, text, type Values } from './arguments';
import { deploy } from './deploy';
import { deploymentOptions } from './deploy-options';
import { deployLocal, readLocalState } from './local-deploy';
import { localPull } from './local-ops';
import { answer } from './prompts';
import { updateShardFile } from './shard-file';
import { deployVps, validateVpsOptions } from './vps-deploy';
import { deployVpsRemote } from './vps-remote';

type Part = 'server' | 'client' | 'ai';
const only: Record<string, Target[]> = {
  'server-port': ['local'],
  'client-port': ['local'],
  'public-host': ['local', 'vps'],
  domain: ['vps'],
  prepare: ['vps'],
  ssh: ['vps'],
  'ssh-port': ['vps'],
  'remote-path': ['vps'],
  'install-deps': ['vps']
};

export async function recordedParts(directory: string, target: Target): Promise<Part[]> {
  if (target === 'local') return (await readLocalState(directory))?.parts ?? [];
  if (target === 'railway') {
    const files: [Part, string][] = [
      ['server', 'railway'],
      ['client', 'webclient'],
      ['ai', 'ai']
    ];
    const found = await Promise.all(files.map(([, name]) => readJson(join(directory, `.gemwright/${name}.json`))));
    return files.filter((_, index) => found[index]).map(([part]) => part);
  }
  const state = await readFile(join(directory, '.gemwright/vps/state.json'), 'utf8').then(JSON.parse, () => undefined);
  return state
    ? ['server', ...(state.client ? (['client'] as const) : []), ...(state.ai ? (['ai'] as const) : [])]
    : [];
}

export async function shardDeploy(values: Values, directory: string, config: ShardConfig) {
  const interactive = !!process.stdin.isTTY && values.yes !== true;
  let target = resolveTarget(directory, config, text(values.target));
  if (!target) {
    if (!interactive) throw new Error('Choose where to deploy: pass --target local, railway or vps.');
    target = answer(
      await prompts.select({
        message: 'Where should this shard run?',
        options: targets.map((value) => ({
          value,
          label: { local: 'This machine (Docker)', railway: 'Railway', vps: 'VPS / your own Linux server' }[value]
        }))
      })
    );
  }
  const misplaced = Object.keys(values).filter((key) => only[key] && !only[key]?.includes(target));
  if (misplaced.length) throw new Error(`--${misplaced.join(', --')} does not apply to --target ${target}.`);
  if ((values.world || values['world-pull']) && !values.ai) throw new Error('--world and --world-pull need --ai.');
  if (values.world && values['world-pull']) throw new Error('Use --world <path> or --world-pull, not both.');
  const named = (['server', 'client', 'ai'] as const).filter((part) => values[part] === true);
  const parts = named.length ? named : await recordedParts(directory, target);
  const flags = {
    files: text(values.files),
    server: !parts.length || parts.includes('server'),
    client: parts.includes('client'),
    ai: parts.includes('ai')
  };
  // A fresh world save comes from the target's own server.
  const pullSaves = async (output: string) => {
    const parts = { server: true, output };
    if (target === 'local') await localPull(parts, directory);
    else if (target === 'railway') await pull(parts, directory, console.log);
    else await pull({ ...parts, vps: vpsRunner(directory, config) }, directory, console.log);
  };
  const world = { saves: text(values.world), pull: values['world-pull'] === true ? pullSaves : undefined };
  if (target === 'local') {
    const publicHost = text(values['public-host']);
    if (publicHost) validateVpsOptions({ publicHost });
    await deployLocal({
      ...flags,
      publicHost,
      serverPort: port(values['server-port'], '--server-port'),
      clientPort: port(values['client-port'], '--client-port'),
      world
    });
  } else if (target === 'railway') await deploy(flags, directory, world);
  else {
    const options = await deploymentOptions({
      files: flags.files,
      server: flags.server,
      client: flags.client,
      ai: flags.ai,
      world,
      publicHost: text(values['public-host']),
      domain: text(values.domain),
      prepare: values.prepare === true,
      ssh: text(values.ssh),
      sshPort: port(values['ssh-port'], '--ssh-port'),
      remotePath: text(values['remote-path']),
      installDeps: values['install-deps'] === true || undefined,
      yes: values.yes === true
    });
    if (options.ssh) await deployVpsRemote(options);
    else await deployVps(options);
    if (options.prepare) return;
    const { ssh, sshPort, remotePath, publicHost, domain } = options;
    await updateShardFile(directory, (file) => {
      file.vps = Object.fromEntries(
        Object.entries({
          ...file.vps,
          ssh,
          port: sshPort,
          path: ssh ? remotePath : undefined,
          publicHost,
          domain: domain ?? file.vps?.domain
        }).filter(([, value]) => value !== undefined)
      );
    });
  }
  await updateShardFile(directory, (file) => {
    file.target = target;
  });
}
