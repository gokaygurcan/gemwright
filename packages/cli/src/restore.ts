import { railway } from '@gemwright/deployment/providers/railway';
import { type RestoreParts, restore as runRestore } from '@gemwright/deployment/restore';
import { loadShard } from '@gemwright/server/config';

import * as prompts from '@clack/prompts';

export type { RestoreParts } from '@gemwright/deployment/restore';
export async function confirmRestore() {
  if (!process.stdin.isTTY) throw new Error('Restore changes the live shard: rerun with --yes to confirm.');
  const confirmed = await prompts.confirm({ message: 'Restore now?', initialValue: false });
  return !prompts.isCancel(confirmed) && confirmed;
}
export function restore(parts: RestoreParts, directory = process.cwd(), run = railway) {
  return runRestore({ loadShard, progress: console.log, confirm: confirmRestore }, parts, directory, run);
}
