import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';

// Talking competes with moving for the same hands: the mouse steers, the keyboard types. A resident
// on the move answers in a word or two, lowercase and sometimes mistyped, or not at all; a real
// conversation needs both sides standing still. When a player addresses a resident, it decides to
// ignore them, answer in passing, or stop: more likely when it is sociable, when the player stands
// close by, and when the player keeps trying. While engaged, every walk waits (navigation.ts) until
// the player leaves, says goodbye, or a quiet minute passes; replies then take typing time.
interface Engagement {
  partner: number;
  until: number;
  // A lot quoted to the partner, sold when they open a trade window (trade-guard.ts).
  // A lot agreed with the partner: the resident sells it, or buys it, in their trade window.
  quote?: { side: 'sell' | 'buy'; good: string; amount: number; price: number };
}
const engagements = new WeakMap<PlayerSession, Engagement>();
const steppedAt = new WeakMap<PlayerSession, number>();
const attempts = new WeakMap<PlayerSession, Map<number, number[]>>();
const MAX_MS = 5 * 60_000;

export const noteStep = (session: PlayerSession) => steppedAt.set(session, Date.now());
export const moving = (session: PlayerSession) => Date.now() - (steppedAt.get(session) ?? 0) < 2000;

export function engagedWith(session: PlayerSession) {
  const now = engagements.get(session);
  if (!now) return undefined;
  const partner = session.world.entities.get(now.partner);
  const here = session.world.position;
  if (Date.now() > now.until || !partner?.position || !here || distance(here, partner.position) > 6) {
    engagements.delete(session);
    return undefined;
  }
  return now;
}

export const endEngagement = (session: PlayerSession) => engagements.delete(session);

export function quoteTo(session: PlayerSession, partner: number, quote: Engagement['quote']) {
  const now = engagedWith(session);
  if (now?.partner === partner) now.quote = quote;
}

// Walks wait here while the resident stands talking.
export async function holdWhileEngaged(session: PlayerSession) {
  const started = Date.now();
  while (engagedWith(session) && session.phase === 'ready' && Date.now() - started < MAX_MS) await Bun.sleep(500);
}

// The resident's choice when a player speaks to it.
export function consider(
  session: PlayerSession,
  partner: number,
  sociability: number,
  intent: string
): 'engaged' | 'brief' | 'ignore' {
  const now = Date.now();
  const current = engagedWith(session);
  if (current?.partner === partner) {
    // Each line keeps the conversation going for another minute, up to five in all.
    current.until = Math.min(now + 60_000, current.until + 60_000, now + MAX_MS);
    return 'engaged';
  }
  if (current) return 'brief';
  const tries = (attempts.get(session) ?? new Map<number, number[]>()).set(
    partner,
    [...(attempts.get(session)?.get(partner) ?? []), now].filter((at) => now - at < 60_000)
  );
  attempts.set(session, tries);
  const them = session.world.entities.get(partner);
  const here = session.world.position;
  const close = !!them?.position && !!here && distance(here, them.position) <= 3;
  const chance =
    (moving(session) ? 0.15 : 0.6) +
    sociability * 0.3 +
    (close ? 0.15 : 0) +
    ((tries.get(partner)?.length ?? 1) - 1) * 0.2 +
    (intent === 'wait' || intent === 'trade' ? 0.3 : 0);
  if (Math.random() < chance) {
    engagements.set(session, { partner, until: now + 60_000 });
    return 'engaged';
  }
  return Math.random() < 0.5 + sociability * 0.4 ? 'brief' : 'ignore';
}

// What a busy resident types with one hand: a word or two, lowercase, sometimes with a slip.
const brief: Record<string, string[]> = {
  greet: ['hi', 'hey', 'o/', 'hail'],
  wait: ['busy', 'cant now', 'sry busy'],
  trade: ['busy rn', 'not now', 'later'],
  doing: ['working', 'busy', 'on my way'],
  bye: ['bye', 'cya', 'fw'],
  acknowledge: ['k', 'ok', 'aye']
};
export function terse(intent: string): string | undefined {
  const options = brief[intent] ?? (intent === 'chatter' ? undefined : ['busy, sry']);
  const line = options?.[Math.floor(Math.random() * options.length)];
  if (!line || line.length < 3 || Math.random() > 0.25) return line;
  // A slip of one hand: two neighbouring letters swapped.
  const i = 1 + Math.floor(Math.random() * (line.length - 2));
  return line.slice(0, i) + (line[i + 1] ?? '') + (line[i] ?? '') + line.slice(i + 2);
}

// Typing time for a line: about five characters a second standing, a quick burst on the move.
export const typingMs = (line: string, onTheMove: boolean) =>
  onTheMove ? 600 + line.length * 120 : 1000 + line.length * (170 + Math.random() * 60);
