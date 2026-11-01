import type { TargetLocation } from '@gemwright/network/packets';
import type { PlayerSession } from '@gemwright/network/session';

// "Use this on that" as one player action for every resident: a tool, a skill or a spell is used,
// the cursor it brings up is answered with an item or a tile, and when no cursor comes the reason
// does — a cursor already up (ours, unanswered), the shard's refusal, or nothing at all. What the use
// achieved (a fish, a log, a cut cloth) is the caller's to confirm.
export type Why = 'cursor-busy' | 'no-cursor' | 'refused';
type CursorOptions = { label: string; ms?: number; refusals?: readonly number[] };
type Outcome = { ok: true } | { why: Why; cliloc?: number; heard?: string };

export const onItem = (item: { serial: number; graphic: number }): TargetLocation => ({
  serial: item.serial,
  x: 0,
  y: 0,
  z: 0,
  graphic: item.graphic
});
export const onTile = (point: { x: number; y: number; z: number }, graphic = 0): TargetLocation => ({
  serial: 0,
  x: point.x,
  y: point.y,
  z: point.z,
  graphic
});

export async function useOn(
  session: PlayerSession,
  use: () => void,
  aim: TargetLocation,
  options: CursorOptions
): Promise<Outcome> {
  if (session.world.target) return { why: 'cursor-busy' };
  return answerCursor(session, aim, options, use);
}

// Answers the cursor the previous step brought up (a gump button, the first half of a two-step
// skill), or the one `use` brings up: it may already be up or arrive shortly. The shard's refusal
// or no cursor in time is the reason.
export async function answerCursor(
  session: PlayerSession,
  aim: TargetLocation,
  options: CursorOptions,
  use?: () => void
): Promise<Outcome> {
  const heard = new Set(session.world.journal);
  const refusal = () =>
    session.world.journal.find((e) => !heard.has(e) && options.refusals?.includes(e.cliloc ?? 0))?.cliloc;
  use?.();
  await session
    .waitFor(() => session.world.target !== null || refusal() !== undefined, options.label, options.ms ?? 3000, {
      resource: 'target'
    })
    .catch((error) => {
      if (session.phase !== 'ready') throw error;
    });
  const refused = refusal();
  if (refused !== undefined) {
    if (session.world.target) session.target(null);
    return { why: 'refused', cliloc: refused };
  }
  // No cursor: what the shard said meanwhile, if anything, is the best clue to why.
  if (!session.world.target) {
    const said = session.world.journal.find((e) => !heard.has(e) && (e.cliloc || e.text));
    return said ? { why: 'no-cursor', heard: said.cliloc ? String(said.cliloc) : said.text } : { why: 'no-cursor' };
  }
  session.target(aim);
  return { ok: true };
}
