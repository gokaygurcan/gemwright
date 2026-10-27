import { createHash } from 'node:crypto';

import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';

const BAN_MS = 2 * 3_600_000;

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
  // An errand that gained nothing waits two hours (the life-goal plan, ROADMAP.md step 2), unless
  // the resident's means change enough to make it worth another try (suppliesCondition).
  entries[key] = {
    failures,
    until: now + BAN_MS,
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

// What reopens a failed errand early: a new kind of item carried, or funds at least doubled (a
// coin of loot or one more of the same does not). Anything finer let errands loop.
export function suppliesCondition(session: PlayerSession, checkpoint: Checkpoint): string {
  const seen = new Set<number>();
  const kinds = new Set<number>();
  const visit = (parent: number) => {
    if (seen.has(parent)) return;
    seen.add(parent);
    for (const item of session.world.childrenOf(parent))
      if (item.layer !== Layer.Bank) {
        kinds.add(item.graphic);
        visit(item.serial);
      }
  };
  visit(session.world.serial ?? -1);
  const funds = (session.world.status?.gold ?? 0) + (checkpoint.funds?.bank ?? 0);
  return createHash('sha256')
    .update(`${Math.floor(Math.log2(funds + 1))}|${[...kinds].sort((a, b) => a - b).join(',')}`)
    .digest('hex');
}

// An errand run once: skipped while it is banned; when it changes nothing the resident owns
// (gold, bank, carried items), it is banned for two hours and the resident says why. True when it
// ran and gained something.
export async function errand(
  ctx: { session: PlayerSession; checkpoint: Checkpoint; log: (text: string) => void },
  key: string,
  what: string,
  run: () => Promise<unknown>
): Promise<boolean> {
  const { session, checkpoint } = ctx;
  if (objectiveBlocked(checkpoint, key, suppliesCondition(session, checkpoint))) return false;
  const before = holdings(session, checkpoint);
  try {
    await run();
  } catch (error) {
    if (session.phase !== 'ready') throw error;
  }
  if (holdings(session, checkpoint) !== before) {
    completeObjective(checkpoint, key);
    return true;
  }
  failObjective(checkpoint, key, suppliesCondition(session, checkpoint), `${what} gained nothing`);
  ctx.log(`Gave up on ${what} for two hours: it gained nothing`);
  return false;
}

// Everything the resident owns, exactly: gold, bank and each carried stack.
function holdings(session: PlayerSession, checkpoint: Checkpoint) {
  const items: string[] = [];
  const visit = (parent: number) => {
    for (const item of session.world.childrenOf(parent))
      if (item.layer !== Layer.Bank) {
        items.push(`${item.graphic}:${item.amount ?? 1}`);
        visit(item.serial);
      }
  };
  visit(session.world.serial ?? -1);
  return `${session.world.status?.gold ?? 0}/${checkpoint.funds?.bank ?? 0}|${items.sort().join(',')}`;
}
