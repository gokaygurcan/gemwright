import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';

export const targets = ['local', 'railway', 'vps'] as const;
export type Target = (typeof targets)[number];

export interface VpsRunner {
  root: string;
  shell: (script: string) => string[];
  // A script running Docker Compose in the deployment folder, in a subshell so several chain.
  compose: (args: string[]) => string;
}

export const sshCommand = (destination?: string, port?: number, flags: string[] = [], program = 'ssh') => [
  program,
  ...flags,
  ...(port ? [program === 'scp' ? '-P' : '-p', String(port)] : []),
  ...(destination ? [destination] : [])
];

export function recordedTargets(directory: string, config: Pick<ShardConfig, 'railway' | 'vps'>): Target[] {
  const has = (path: string) => existsSync(join(directory, '.gemwright', path));
  return targets.filter((target) =>
    target === 'local'
      ? has('local/state.json')
      : target === 'railway'
        ? !!config.railway || ['railway.json', 'ai.json', 'webclient.json'].some(has)
        : !!config.vps
  );
}

// The deployment a command acts on: the one named, the one last deployed, or the only one there is.
export function resolveTarget(
  directory: string,
  config: Pick<ShardConfig, 'railway' | 'vps' | 'target'>,
  requested?: string
): Target | undefined {
  if (requested !== undefined) {
    if (!targets.includes(requested as Target)) throw new Error('--target must be local, railway or vps.');
    return requested as Target;
  }
  if (config.target) return config.target;
  const recorded = recordedTargets(directory, config);
  if (recorded.length > 1) throw new Error(`This shard has ${recorded.join(', ')} deployments: pass --target.`);
  return recorded[0];
}

export function requireTarget(...args: Parameters<typeof resolveTarget>): Target {
  const target = resolveTarget(...args);
  if (!target) throw new Error('No deployment found here. Pass --target local, railway or vps.');
  return target;
}

export function vpsRunner(directory: string, config: Pick<ShardConfig, 'id' | 'vps'>): VpsRunner {
  const { vps } = config;
  if (!vps)
    throw new Error('gemwright.json has no vps settings. Run gemwright shard setup, or deploy with --target vps.');
  const { ssh, port } = vps;
  const root = ssh ? (vps.path ?? `gemwright/${config.id}`) : join(directory, '.gemwright/vps');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    root,
    shell: (script) => (ssh ? [...sshCommand(ssh, port), script] : ['sh', '-c', script]),
    compose: (args: string[]) =>
      `(cd ${quote(root)} && if docker info >/dev/null 2>&1; then docker=docker; else docker='sudo -n docker'; fi && $docker compose -f compose.json ${args.map(quote).join(' ')})`
  };
}
