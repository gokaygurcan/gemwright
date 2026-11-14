import { join, resolve } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';

import { command } from './process';
import { requireTarget, vpsRunner } from './target';

// One traced decision of a resident weighed again where its history and world live: inside the
// deployed AI container (packages/ai v2/simulate-cli.ts). Returns its JSON report.
export async function simulateDecision(
  directory: string,
  config: Pick<ShardConfig, 'id' | 'railway' | 'vps' | 'target'>,
  id: number
): Promise<unknown> {
  const args = ['exec', '-T', 'ai', 'bun', 'dist/v2/simulate-cli.js', '--id', String(id)];
  const target = requireTarget(directory, config);
  let output: string;
  if (target === 'local') {
    const root = join(resolve(directory), '.gemwright/local');
    output = await command(['docker', 'compose', '-f', 'compose.json', ...args], root);
  } else if (target === 'vps') {
    const vps = vpsRunner(directory, config);
    output = await command(vps.shell(vps.compose(args)), directory);
  } else throw new Error('Decisions are simulated on a local or VPS deployment.');
  const report = output.trim().split('\n').at(-1);
  if (!report) throw new Error('The simulation printed nothing.');
  return JSON.parse(report);
}
