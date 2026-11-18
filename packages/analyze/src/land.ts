import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';
import { command } from '@gemwright/deployment/process';
import { toFile } from '@gemwright/deployment/pull';
import { requireTarget, vpsRunner } from '@gemwright/deployment/target';

// The land a pull's residents lived on, for decisions made again (replay-runner.ts): the deployed
// AI's world files, shard settings and walk caches, copied once into <pull>/land beside links to
// the pull's history and the client's map files, so it reads as the AI's data folder does.
const PARTS = 'world gemwright.json walk-graph-*.bin areas-*.json routes-*.json';

export async function landOf(
  directory: string,
  config: Pick<ShardConfig, 'id' | 'railway' | 'vps' | 'target'>,
  pull: string,
  files: string
): Promise<string> {
  const land = join(pull, 'land');
  if (existsSync(join(land, 'assets'))) return land;
  rmSync(land, { recursive: true, force: true });
  mkdirSync(land, { recursive: true });
  const args = [
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'sh',
    'ai',
    '-c',
    `cd /app/data && tar czf - ${PARTS}`
  ];
  const target = requireTarget(directory, config);
  const archive = join(land, 'land.tar.gz');
  if (target === 'local')
    await toFile(
      ['docker', 'compose', '-f', join(resolve(directory), '.gemwright/local/compose.json'), ...args],
      archive
    );
  else if (target === 'vps') {
    const vps = vpsRunner(directory, config);
    await toFile(vps.shell(vps.compose(args)), archive);
  } else throw new Error('Decisions are made again from a local or VPS deployment’s land.');
  await command(['tar', '-xzf', archive, '-C', land], land);
  rmSync(archive);
  symlinkSync(join(pull, 'ai/history.sqlite'), join(land, 'history.sqlite'));
  symlinkSync(resolve(files), join(land, 'assets'));
  return land;
}
