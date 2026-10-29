import type { PlayerSession } from '@gemwright/network/session';

import { canPause } from './action-purpose';
import { reserveInteraction } from './execution-session';
import { distance } from './navigation';

// Talking competes with moving for the same hands: the mouse steers, the keyboard types. A resident
// on the move answers briefly, lowercase and sometimes mistyped, but always answers a player; a real
// conversation needs both sides standing still. When a player addresses a resident, it answers in
// passing or stops: stopping is more likely when it is sociable, when the player stands close by,
// keeps trying, or asks a real question. While engaged, every walk waits (navigation.ts) until
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
// Talking to one person has an end, the way it does for a person: after a few lines, or the same
// line a third time, the resident says goodbye once and gets on with its work. Later lines are not
// answered at all unless they name it, and then only a word in passing (conversation.ts asks here).
const PATIENCE_LINES = 6;
const PATIENCE_REPEATS = 3;
const PATIENCE_MS = 10 * 60_000;
const heardFrom = new WeakMap<PlayerSession, Map<number, { text: string; at: number; request: boolean }[]>>();
const bored = new WeakMap<PlayerSession, Map<number, { until: number; told: boolean; lastWord: number }>>();
const MAX_MS = 5 * 60_000;

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface Patience {
  // 'ok' answers as usual, 'brief' answers without stopping, 'decline' answers nothing at all.
  verdict: 'ok' | 'brief' | 'decline';
  reason?: string;
  say?: string;
}

// Requests are not small talk. A player may ask the same question twice because a reply was missed,
// or because it matters: those are answered (only a question put five times tires a resident), while
// idle repeats of greetings and chatter are what make it say "you've said that already" and move on.
const REQUESTS = new Set(['where', 'help', 'needs', 'plans', 'trade', 'follow', 'wait']);
const REQUEST_REPEATS = 5;
const REQUEST_MS = 5 * 60_000;

// Whether this resident still has patience for a line from that talker (called for player speech).
export function patienceFor(
  session: PlayerSession,
  partner: number,
  text: string,
  line: { named: boolean; intent?: string },
  now = Date.now()
): Patience {
  const lines = heardFrom.get(session) ?? new Map<number, { text: string; at: number; request: boolean }[]>();
  heardFrom.set(session, lines);
  const states = bored.get(session) ?? new Map<number, { until: number; told: boolean; lastWord: number }>();
  bored.set(session, states);
  const state = states.get(partner) ?? { until: 0, told: false, lastWord: 0 };
  states.set(partner, state);
  // The boredom lifts after its window: patience starts fresh for that talker.
  if (state.until && state.until <= now) {
    state.until = 0;
    state.told = false;
    lines.set(partner, []);
  }
  const same = normalize(text);
  const request = REQUESTS.has(line.intent ?? '');
  const heard = [...(lines.get(partner) ?? []), { text: same, at: now, request }].filter(
    (entry) => now - entry.at < PATIENCE_MS
  );
  lines.set(partner, heard);
  const repeats = heard.filter((entry) => entry.text === same && same.length > 2).length;
  if (state.until > now) {
    // Bored already: a fresh line that names the resident, or a real request, gets one word a
    // minute in passing. Repeats and idle lines get nothing, and insisters stay boring for longer.
    if ((line.named || request) && repeats < PATIENCE_REPEATS && now - state.lastWord > 60_000) {
      state.lastWord = now;
      return { verdict: 'brief', reason: 'bored, a word in passing' };
    }
    state.until = now + PATIENCE_MS;
    return {
      verdict: 'decline',
      reason: `bored (${repeats >= PATIENCE_REPEATS ? `${repeats}x the same line` : 'nothing more to say'})`
    };
  }
  if (request) {
    // The same request five times in ten minutes: answered with one weary line, then a pause.
    if (repeats >= REQUEST_REPEATS) {
      state.until = now + REQUEST_MS;
      if (!state.told) {
        state.told = true;
        return {
          verdict: 'decline',
          reason: `the same request ${repeats} times`,
          say: 'I have told thee already, friend.'
        };
      }
      return { verdict: 'decline', reason: `the same request ${repeats} times, told already` };
    }
    return { verdict: 'ok' };
  }
  const smallTalk = heard.filter((entry) => !entry.request).length;
  if (repeats >= PATIENCE_REPEATS || smallTalk >= PATIENCE_LINES || heard.length >= PATIENCE_LINES + 4) {
    const repeat = repeats >= PATIENCE_REPEATS;
    const reason = repeat ? `${repeats}x the same line` : `${heard.length} lines from one talker`;
    state.until = now + PATIENCE_MS;
    if (!state.told) {
      state.told = true;
      return {
        verdict: 'decline',
        reason: `bored (${reason})`,
        say: "You've said that already, friend. I've work to do."
      };
    }
    return { verdict: 'decline', reason: `bored (${reason}), said so already` };
  }
  return { verdict: 'ok' };
}
export const boredWith = (session: PlayerSession, partner: number) =>
  (bored.get(session)?.get(partner)?.until ?? 0) > Date.now();

export const noteStep = (session: PlayerSession) => steppedAt.set(session, Date.now());
export const moving = (session: PlayerSession) => Date.now() - (steppedAt.get(session) ?? 0) < 2000;

export function engagedWith(session: PlayerSession) {
  if (!canPause(session)) {
    endEngagement(session);
    return undefined;
  }
  const now = engagements.get(session);
  if (!now) return undefined;
  const partner = session.world.entities.get(now.partner);
  const here = session.world.position;
  if (Date.now() > now.until || !partner?.position || !here || distance(here, partner.position) > 6) {
    endEngagement(session);
    return undefined;
  }
  return now;
}

export const endEngagement = (session: PlayerSession) => {
  reserveInteraction(session, 0);
  return engagements.delete(session);
};

export function quoteTo(session: PlayerSession, partner: number, quote: Engagement['quote']) {
  const now = engagedWith(session);
  if (now?.partner === partner) now.quote = quote;
}

// Walks wait here while the resident stands talking.
export async function holdWhileEngaged(session: PlayerSession, check: () => void = () => {}) {
  const started = Date.now();
  while (session.phase === 'ready' && Date.now() - started < MAX_MS) {
    const trade = session.world.trade;
    if (!canPause(session)) {
      if (trade && !trade.closed) session.cancelTrade();
      return;
    }
    if ((!trade || trade.closed) && !engagedWith(session)) return;
    check();
    await Bun.sleep(100);
  }
}

// The resident's choice when a player speaks to it.
export function consider(
  session: PlayerSession,
  partner: number,
  sociability: number,
  intent: string
): 'engaged' | 'brief' {
  if (!canPause(session)) {
    endEngagement(session);
    return 'brief';
  }
  // Bored with this talker (patienceFor): a word in passing at most, never standing still again.
  if (boredWith(session, partner)) return 'brief';
  const now = Date.now();
  const current = engagedWith(session);
  if (current?.partner === partner) {
    // Each line keeps the conversation going for another minute, up to five in all.
    current.until = Math.min(now + 60_000, current.until + 60_000, now + MAX_MS);
    reserveInteraction(session, current.until);
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
    (intent === 'wait' || intent === 'trade' ? 0.3 : 0) +
    // A real question deserves stopping for: where it is going, what it needs, what it does.
    (['plans', 'needs', 'doing', 'where', 'help'].includes(intent) ? 0.4 : 0);
  if (intent === 'trade' || intent === 'wait' || Math.random() < chance) {
    engagements.set(session, { partner, until: now + 60_000 });
    reserveInteraction(session, now + 60_000);
    return 'engaged';
  }
  // A player who speaks is always answered: in passing, if not standing.
  return 'brief';
}

// What a busy resident types with one hand: a word or two, lowercase, sometimes with a slip.
const brief: Record<string, string[]> = {
  greet: ['hi', 'hey', 'o/', 'hail'],
  wait: ['busy', 'cant now', 'sry busy'],
  trade: ['busy rn', 'not now', 'later'],
  doing: ['working', 'busy', 'on my way'],
  bye: ['bye', 'cya', 'fw'],
  acknowledge: ['k', 'ok', 'aye'],
  chatter: ['hm?', 'yes?', 'aye?']
};
export function terse(intent: string): string | undefined {
  const options = brief[intent] ?? ['busy, sry'];
  const line = options?.[Math.floor(Math.random() * options.length)];
  return line;
}

// Typing time for a line: about five characters a second standing, a quick burst on the move.
export const typingMs = (line: string, onTheMove: boolean) =>
  onTheMove ? 600 + line.length * 120 : 1000 + line.length * (170 + Math.random() * 60);
