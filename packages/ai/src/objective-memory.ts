import { createHash } from 'node:crypto';

import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';

export interface ObjectiveFailure {
  failures: number;
  until: number;
  condition: string;
  reason: string;
}

export function objectiveBlocked(checkpoint: Checkpoint, key: string, condition: string, now = Date.now()): boolean {
  const failed = checkpoint.objectives?.[key];
  return !!failed && failed.until > now && failed.condition === condition;
}

export function failObjective(
  checkpoint: Checkpoint,
  key: string,
  condition: string,
  reason: string,
  now = Date.now()
) {
  checkpoint.objectives ??= {};
  const entries = checkpoint.objectives;
  const previous = entries[key];
  const failures = previous?.condition === condition ? Math.min(8, previous.failures + 1) : 1;
  entries[key] = {
    failures,
    until: now + Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1)),
    condition,
    reason: reason.slice(0, 240)
  };
  const oldest = Object.keys(entries).sort((a, b) => (entries[a]?.until ?? 0) - (entries[b]?.until ?? 0));
  for (const key of oldest.slice(0, Math.max(0, oldest.length - 64))) delete entries[key];
  return entries[key]?.until ?? now;
}

export function completeObjective(checkpoint: Checkpoint, key: string) {
  if (checkpoint.objectives) delete checkpoint.objectives[key];
}

// Only a change in usable possessions or funds reopens procurement, not unrelated world packets.
export function suppliesCondition(session: PlayerSession, checkpoint: Checkpoint): string {
  const seen = new Set<number>();
  const visit = (parent: number): string[] => {
    if (seen.has(parent)) return [];
    seen.add(parent);
    return session.world
      .childrenOf(parent)
      .filter((item) => item.layer !== Layer.Bank)
      .flatMap((item) => [`${item.serial}:${item.graphic}:${item.amount ?? 1}`, ...visit(item.serial)]);
  };
  return createHash('sha256')
    .update(
      `${session.world.status?.gold ?? 0}/${checkpoint.funds?.bank ?? 0}|${visit(session.world.serial ?? -1)
        .sort()
        .join(',')}`
    )
    .digest('hex');
}
