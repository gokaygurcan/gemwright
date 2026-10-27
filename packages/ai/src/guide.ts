import type { PlayerSession } from './protocol/session';

// Walking a lost player somewhere they asked about ("show me the bank"): the answer agrees
// (conversation-answers.ts) and leaves the walk here; the resident's next housekeeping
// (shared-turn.ts) takes it there at a walk and says so, if it is not too far.
interface Guide {
  to: { x: number; y: number };
  name: string;
  place: string;
  until: number;
}
const guides = new WeakMap<PlayerSession, Guide>();

export const askGuide = (session: PlayerSession, guide: Omit<Guide, 'until'>) =>
  guides.set(session, { ...guide, until: Date.now() + 3 * 60_000 });

// True when it walked someone to a place this turn.
export async function guideTurn(ctx: {
  session: PlayerSession;
  navigate: (goal: { x: number; y: number }, range: number) => Promise<unknown>;
  phase: (phase: string, note: string) => void;
}): Promise<boolean> {
  const guide = guides.get(ctx.session);
  if (!guide) return false;
  guides.delete(ctx.session);
  if (guide.until < Date.now()) return false;
  ctx.phase('guiding', `Showing ${guide.name} the way to the ${guide.place}`);
  await ctx.navigate(guide.to, 2).catch(() => {});
  ctx.session.say(`Here is the ${guide.place}, ${guide.name}.`);
  return true;
}
