import { DangerInterrupt } from './action-purpose';
import type { CharacterArchetype } from './archetypes';
import { failObjective, suppliesCondition } from './objective-memory';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { SessionBreak } from './session-habits';
import { trainSupportingSkill } from './skill-training';
import type { Checkpoint } from './store';

// Residents never quit over a world condition (sold-out vendor, low health, an unreachable spot).
// Returns false when the error must still end the run: shutdown, deadline, lost connection or
// lost shard ownership, which the supervisor handles without replaying anything.
export function isSetback(session: PlayerSession, error: unknown, stopping: boolean, deadline: number): boolean {
  if (error instanceof SessionBreak) return false;
  if (stopping || Date.now() >= deadline || session.phase !== 'ready') return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/no longer owns this shard|outcome is uncertain|disconnected/i.test(message);
}

// Recovery or practice fills the retry delay; repeated unchanged failures extend it.
async function handleSetback(
  ctx: {
    session: PlayerSession;
    check: () => void;
    phase: (phase: string, note: string) => void;
    log: (message: string) => void;
    archetype?: CharacterArchetype;
    items: () => Entity[];
    deadline: number;
    checkpoint?: Checkpoint;
    recover?: () => Promise<void>;
  },
  reason: string
) {
  ctx.log(`Setback: ${reason}; doing something else before trying again`);
  // No money for a tool or supplies: the way out is to earn, so a side trade for two hours. Going
  // in circles is not handled here: the loop guard puts it back to its job (loop-watch.ts).
  if (
    /afford|insufficient|no gold|cannot work without|could be obtained|was observed/i.test(reason) &&
    ctx.checkpoint
  ) {
    const now = Date.now();
    ctx.checkpoint.sideTrade = { checkAt: now, funds: 0, ...ctx.checkpoint.sideTrade, until: now + 2 * 3_600_000 };
  }
  ctx.phase('setback', reason);
  if (ctx.checkpoint)
    failObjective(
      ctx.checkpoint,
      `setback:${reason.slice(0, 160)}`,
      suppliesCondition(ctx.session, ctx.checkpoint),
      reason
    );
  // The failed objective stays banned (objective-memory.ts), but the resident itself pauses only a
  // minute or two: standing longer is the nonsense the loop guard exists to stop.
  const until = Math.min(ctx.deadline, Date.now() + (30 + Math.random() * 60) * 1000);
  try {
    await ctx.recover?.();
  } catch (error) {
    if (ctx.session.phase !== 'ready') throw error;
  }
  const practised = Date.now() < until ? await trainSupportingSkill({ ...ctx, until }).catch(() => 0) : 0;
  // Even maxed skills must not bypass a failed objective's retry deadline.
  const resume = practised ? until : Math.min(until, Date.now() + 15_000);
  while (Date.now() < resume) {
    ctx.check();
    await Bun.sleep(2000);
  }
}

export async function passSetback(...args: Parameters<typeof handleSetback>) {
  try {
    await handleSetback(...args);
  } catch (error) {
    if (!(error instanceof DangerInterrupt)) throw error;
  }
}
