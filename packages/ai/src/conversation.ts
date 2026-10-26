import { canPause } from './action-purpose';
import { notePlayer, tally } from './activity';
import { hearAid, observeAid } from './aid';
import { answer } from './conversation-answer-flow';
import type { Listener, Options } from './conversation-types';
import { baselineIntent, type Intent, QUIET_MS, stopWords, threadFor } from './dialogue';
import { endEngagement } from './engagement';
import { groupMember } from './group-awareness';
import { info } from './log';
import { parseMarketLine } from './market';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { JournalEntry } from './protocol/world';
import { registerResident } from './resident-context';
import { asksSharedPlan, hearPlanControl } from './shared-plans';
import type { Checkpoint } from './store';

// Speech uses bounded partner threads and truthful replies from dialogue.ts. Jev can choose
// intents and replies; following remains declined until commitments become actionable goals.
export function intentOf(text: string): Intent | undefined {
  const intent = baselineIntent(text);
  return intent === 'chatter' ? undefined : intent;
}

// One listener per resident (several share this process), polling the journal every 1.5 s.
const listeners = new WeakMap<Checkpoint, Listener>();

export function converse(options: Options) {
  registerResident(options);
  observeAid(options.session);
  const existing = listeners.get(options.checkpoint);
  if (existing) {
    existing.options = options;
    return;
  }
  const listener: Listener = {
    options,
    threads: new Map(),
    handled: new WeakSet(),
    known: new Set([...(options.peers?.values() ?? [])].map((name) => name.split(' ')[0]?.toLowerCase() ?? '')),
    busy: false,
    lastSpoke: 0,
    quietUntil: 0,
    timer: setInterval(() => {
      if (listener.options.session.phase === 'offline' || listener.options.session.phase === 'failed') {
        clearInterval(listener.timer);
        listeners.delete(options.checkpoint);
        return;
      }
      if (listener.busy) return;
      listener.busy = true;
      void listen(listener)
        .catch((error) =>
          log(listener.options.session, `listener error: ${error instanceof Error ? error.message : error}`)
        )
        .finally(() => {
          listener.busy = false;
        });
    }, 1500)
  };
  listeners.set(options.checkpoint, listener);
}

// Whether the resident is in its pause after a conversation (no greetings, no small talk).
export function quietNow(checkpoint: Checkpoint) {
  return (listeners.get(checkpoint)?.quietUntil ?? 0) > Date.now();
}

// A line this resident started a conversation with (a greeting), so the answer continues it.
export function noteSpoken(checkpoint: Checkpoint, partner: number, name: string, text: string, peer: boolean) {
  const listener = listeners.get(checkpoint);
  if (!listener) return;
  const thread = threadFor(listener.threads, partner, name, peer);
  thread.turns.push({ from: 'me', text, intent: 'greet', at: Date.now() });
  thread.lastAt = Date.now();
}

const log = (session: PlayerSession, text: string) =>
  info(`[talk:${session.world.entities.get(session.world.serial ?? -1)?.name ?? 'resident'}] ${text}`);

async function listen(listener: Listener) {
  const { session, peers } = listener.options;
  if (session.phase !== 'ready') return;
  const me = session.world.entities.get(session.world.serial ?? -1);
  const here = session.world.position;
  if (!me || !here) return;
  const firstName = (me.name ?? '').split(' ')[0]?.toLowerCase() ?? '';
  for (const entry of session.world.journal) {
    if (listener.handled.has(entry)) continue;
    listener.handled.add(entry);
    hearAid(session, entry);
    if (hearPlanControl(session, entry)) continue;
    if (!canPause(session)) {
      endEngagement(session);
      continue;
    }
    if (
      entry.party &&
      entry.text &&
      asksSharedPlan(entry.text) &&
      groupMember(session, entry.serial) &&
      Date.now() - Date.parse(entry.at) < 8000
    ) {
      const thread = threadFor(
        listener.threads,
        entry.serial,
        entry.name || 'companion',
        peers?.has(entry.serial) ?? false
      );
      await answer(listener, thread, entry, here);
      continue;
    }
    // Party chat carries the dungeon party's coordination (dungeon-party.ts), not conversation.
    if (entry.text === undefined || entry.type === 6 || entry.type === 2 || entry.party) continue;
    if (entry.serial === session.world.serial || entry.serial === 0xffffffff) continue;
    // Words players say to NPCs and pets (bankers, trainers, vendors) are not conversation.
    if (
      /^\s*(?:bank|balance|withdraw \d+|claim|vendor (?:buy|sell)|all (?:kill|follow me|guard me|stop|come))\s*$/i.test(
        entry.text
      )
    )
      continue;
    const heardKey = `${entry.serial}:${entry.at}:${entry.text}`;
    // Market shouts and haggling (market.ts) are business, answered by the market, not small talk;
    // a player's line is recorded as a price and demand signal (activity.ts).
    const market = parseMarketLine(entry.text);
    if (market) {
      const { kind, n, good, total } = market;
      notePlayer(session, heardKey, {
        kind: 'market',
        serial: entry.serial,
        name: entry.name,
        offer: kind,
        good,
        amount: n,
        price: total
      });
      continue;
    }
    // Only speech heard in the last half minute; older journal lines are history.
    if (Date.now() - Date.parse(entry.at) > 30_000) continue;
    const speaker = session.world.entities.get(entry.serial);
    const peer = peers?.has(entry.serial) ?? false;
    const named = firstName.length > 2 && new RegExp(`\\b${firstName}\\b`, 'i').test(entry.text);
    const open = listener.threads.get(entry.serial);
    const ongoing = !!open && !open.closed && Date.now() - open.lastAt < 10 * 60_000;
    const near = !!speaker?.position && distance(here, speaker.position) <= 4;
    // A line naming someone else, and not this resident, is their conversation. Names come from
    // speech heard and the roster: the client often has not learned a nearby mobile's name.
    const speakerFirst = (entry.name ?? '').split(' ')[0]?.toLowerCase() ?? '';
    for (const m of session.world.entities.values())
      if (m.kind === 'mobile' && m.name) listener.known.add(m.name.split(' ')[0]?.toLowerCase() ?? '');
    const forOther = [...listener.known].some(
      (other) =>
        other.length > 2 &&
        other !== firstName &&
        other !== speakerFirst &&
        new RegExp(`\\b${other}\\b`, 'i').test(entry.text ?? '')
    );
    if (speakerFirst) listener.known.add(speakerFirst);
    if (forOther && !named) continue;
    // Fellow residents are answered only when they address this one; players also when close by.
    if (!named && !ongoing && (peer || !near)) continue;
    // Speech aimed at this resident: a player's presence is recorded (when and where, not the words).
    notePlayer(session, heardKey, { kind: 'speech', serial: entry.serial, name: entry.name });
    const name = entry.name || speaker?.name || peers?.get(entry.serial) || 'friend';
    // A finished conversation stays finished for a while: small talk gets nothing, a real request
    // one brush-off, so the resident moves on instead of starting over with the same person.
    // A player who speaks again after a goodbye starts the conversation anew.
    if (!peer && open?.closed) {
      open.closed = false;
      open.resumed = true;
    }
    if (open?.closed && Date.now() - open.lastAt < QUIET_MS) {
      const asked = ['where', 'help', 'follow'].includes(baselineIntent(entry.text));
      if (asked && !open.brushedOff && session.phase === 'ready') {
        open.brushedOff = true;
        tally(session, 'speech');
        session.say(`We have spoken already, ${name}. I must return to my work.`);
      }
      log(session, `${name}: "${entry.text}" -> ignored, conversation already ended${asked ? '' : ' (small talk)'}`);
      continue;
    }
    // Not named, yet possibly meant for me (mid-conversation, or standing close) while others are
    // around: ask Jev whether it is addressed to me. The local rule keeps answering.
    const company = [...session.world.entities.values()].filter(
      (m) =>
        m.kind === 'mobile' &&
        m.serial !== session.world.serial &&
        m.serial !== entry.serial &&
        !!m.position &&
        distance(here, m.position) <= 8 &&
        (m.name || peers?.has(m.serial))
    );
    if (
      !named &&
      company.length &&
      !(await addressedToMe(
        listener,
        entry,
        name,
        company.map((m) => m.name ?? peers?.get(m.serial) ?? 'someone')
      ))
    ) {
      log(session, `${name}: "${entry.text}" -> not addressed to me`);
      continue;
    }
    // The pause after a conversation: only a real request is still answered, stop words always win.
    if (peer && listener.quietUntil > Date.now() && !['where', 'help', 'follow'].includes(baselineIntent(entry.text))) {
      log(
        session,
        `${name}: "${entry.text}" -> ignored, resting my voice${stopWords.test(entry.text) ? ' (already quiet)' : ''}`
      );
      continue;
    }
    const thread = threadFor(listener.threads, entry.serial, name, peer);
    await answer(listener, thread, entry, here);
    if (session.phase !== 'ready' || !canPause(session)) return;
  }
}

// "Is this addressed to me?" for a line that does not name anyone: the recent speech around, who
// is nearby, and whether this resident is mid-conversation with the speaker.
async function addressedToMe(listener: Listener, entry: JournalEntry, speaker: string, company: string[]) {
  const { session, checkpoint, decisions } = listener.options;
  if (!decisions) return true;
  const me = session.world.entities.get(session.world.serial ?? -1)?.name ?? 'me';
  const recent = session.world.journal
    .filter((e) => e.text && e.type !== 6 && e.type !== 2 && !e.cliloc && Date.now() - Date.parse(e.at) < 60_000)
    .slice(-6)
    .map((e) => `${e.serial === session.world.serial ? `${me} (me)` : e.name}: ${e.text}`);
  const thread = listener.threads.get(entry.serial);
  const pick = await decisions.choose({
    kind: 'speech-addressee',
    checkpoint,
    observationRevision: session.world.revision,
    state: {
      me,
      line: entry.text,
      speaker,
      othersNearby: company.slice(0, 6),
      recentSpeech: recent,
      talkingWithSpeaker: !!thread && !thread.closed,
      myLastLineToSpeaker: thread?.turns.findLast((turn) => turn.from === 'me')?.text
    },
    candidates: [
      {
        id: 'to-me',
        description: `${speaker} is speaking to ${me}, or to everyone including ${me}.`,
        valid: () => true
      },
      {
        id: 'to-someone-else',
        description: `${speaker} is answering or speaking to someone else nearby, not ${me}.`,
        valid: () => true
      }
    ],
    baseline: 'to-me',
    stillCurrent: () => session.phase === 'ready'
  });
  decisions.finish(checkpoint, pick, 'completed', `Judged "${(entry.text ?? '').slice(0, 40)}" ${pick?.id ?? 'to-me'}`);
  return pick?.id !== 'to-someone-else';
}
