import type { CharacterArchetype } from './archetypes';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { trainSupportingSkill } from './skill-training';

// Residents never quit over a world condition (sold-out vendor, low health, an unreachable spot).
// Returns false when the error must still end the run: shutdown, deadline, lost connection or
// lost shard ownership, which the supervisor handles without replaying anything.
export function isSetback(session: PlayerSession, error: unknown, stopping: boolean, deadline: number): boolean {
  if (stopping || Date.now() >= deadline || session.phase !== 'ready') return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/no longer owns this shard|outcome is uncertain|disconnected/i.test(message);
}

// Spends one to three minutes on something useful (recovery, then a supporting skill), then the
// caller resumes its routine. Bounded so a repeating setback never spins.
export async function passSetback(
  ctx: {
    session: PlayerSession;
    check: () => void;
    phase: (phase: string, note: string) => void;
    log: (message: string) => void;
    archetype?: CharacterArchetype;
    items: () => Entity[];
    deadline: number;
    recover?: () => Promise<void>;
  },
  reason: string
) {
  ctx.log(`Setback: ${reason}; doing something else before trying again`);
  ctx.phase('setback', reason);
  const until = Math.min(ctx.deadline, Date.now() + (60 + Math.random() * 120) * 1000);
  try {
    await ctx.recover?.();
  } catch (error) {
    if (ctx.session.phase !== 'ready') throw error;
  }
  const practised = Date.now() < until ? await trainSupportingSkill({ ...ctx, until }).catch(() => 0) : 0;
  // With nothing left to practise (every supporting skill maxed), only a short pause, then back to work.
  const resume = practised ? until : Math.min(until, Date.now() + 15_000);
  while (Date.now() < resume) {
    ctx.check();
    await Bun.sleep(2000);
  }
}
