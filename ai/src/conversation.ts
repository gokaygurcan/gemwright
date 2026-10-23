import { notePlayer, tally } from './activity';
import type { CharacterTemplate } from './config';
import { worldAnswer } from './conversation-answers';
import type { DecisionCoordinator } from './decisions';
import {
  baselineIntent,
  type Intent,
  intents,
  QUIET_MS,
  replyOptions,
  stopWords,
  type Thread,
  threadFor
} from './dialogue';
import { consider, endEngagement, moving, terse, typingMs } from './engagement';
import { parseMarketLine } from './market';
import { distance } from './navigation';
import { phrase } from './phrasing';
import { readTradeTalk } from './player-trade';
import type { PlayerSession } from './protocol/session';
import type { JournalEntry } from './protocol/world';
import type { Checkpoint } from './store';

// Residents hear and answer speech: from players near them or naming them, and from fellow
// residents naming them or continuing a conversation. Each line is read into an intent (Jev when
// configured, otherwise the authored patterns) and answered with one of the truthful replies
// dialogue.ts offers (again Jev's pick, or the local rule). Replies come from real state only: the
// goal, home town and catalogued landmarks. Requests to follow are declined until commitments
// become goals. Conversations are threads per partner, capped in turns, so residents never loop.
export function intentOf(text: string): Intent | undefined {
  const intent = baselineIntent(text);
  return intent === 'chatter' ? undefined : intent;
}

// What a resident says it is doing, from its persisted goal phase.
export function activityLine(checkpoint: Checkpoint): string {
  const phase = checkpoint.goal?.phase ?? '';
  const ground = checkpoint.hunting?.ground ?? 'Britain';
  if (/fight|engag|pet-combat/.test(phase)) return 'I am too busy fighting to talk!';
  if (/patrol|choosing-opponent|hunting|graveyard|changing-ground/.test(phase))
    return `I hunt the undead at the ${ground} cemetery.`;
  if (/thief/.test(phase)) return 'Minding mine own business.';
  if (/mining|mine-travel/.test(phase)) return 'I work the mines, seeking good ore.';
  if (/smelt|forge/.test(phase)) return 'I am smelting ore at the forge.';
  if (/smithing/.test(phase)) return 'I am smithing a few shields to sell.';
  if (/tam|companion/.test(phase)) return 'I seek animals to tame.';
  if (/fish/.test(phase)) return 'Fishing, and mostly waiting for a bite.';
  if (/bank/.test(phase)) return 'I am off to the bank.';
  if (/sell|restock|resupply|purchase|armor|training/.test(phase)) return 'Doing a bit of trading in town.';
  if (/rest|recover|heal/.test(phase)) return 'Catching my breath before I head out again.';
  if (/travel|moongate|mount/.test(phase)) return 'I am on the road.';
  return 'Just going about my business.';
}

type Options = {
  session: PlayerSession;
  checkpoint: Checkpoint;
  template: CharacterTemplate;
  city: string;
  peers?: ReadonlyMap<number, string>;
  decisions?: DecisionCoordinator;
};
interface Listener {
  options: Options;
  threads: Map<number, Thread>;
  handled: WeakSet<JournalEntry>;
  // First names heard in speech or on the roster, to tell when a line is meant for someone else.
  known: Set<string>;
  busy: boolean;
  lastSpoke: number;
  // After a conversation ends the resident pauses talking to anyone, requests aside.
  quietUntil: number;
  timer: ReturnType<typeof setInterval>;
}
// One listener per resident (several share this process), polling the journal every 1.5 s.
const listeners = new WeakMap<Checkpoint, Listener>();

export function converse(options: Options) {
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
  console.error(`[talk:${session.world.entities.get(session.world.serial ?? -1)?.name ?? 'resident'}] ${text}`);

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
    if (session.phase !== 'ready') return;
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

async function answer(listener: Listener, thread: Thread, entry: JournalEntry, here: { x: number; y: number }) {
  const { session, checkpoint, template, decisions } = listener.options;
  const text = (entry.text ?? '').slice(0, 160);
  const recent = thread.turns.slice(-4).map((turn) => `${turn.from === 'me' ? 'me' : thread.name}: ${turn.text}`);
  // Understanding: the pattern rule is the baseline; Jev reads the line in context.
  const baseline = baselineIntent(text);
  // Jev takes at most eight candidates: the core eight, with "where", "help" or "follow" in place
  // of "clarify" when the rule read the line that way.
  const core: Intent[] = ['greet', 'doing', 'wait', 'trade', 'acknowledge', 'clarify', 'bye', 'chatter'];
  const candidates = core.includes(baseline) ? core : [...core.filter((i) => i !== 'clarify'), baseline];
  const read = decisions
    ? await decisions.choose({
        kind: 'speech-intent',
        checkpoint,
        observationRevision: session.world.revision,
        state: { line: text, speaker: thread.name, speakerIsResident: thread.peer, conversationSoFar: recent },
        candidates: candidates.map((intent) => ({
          id: intent,
          description: intents[intent].description,
          valid: () => true
        })),
        baseline,
        stillCurrent: () => session.phase === 'ready'
      })
    : null;
  // A player's free-form trade talk ("wtb 50 boards") is trade, whatever else it reads as.
  const talk = thread.peer ? undefined : await readTradeTalk(text);
  // What the player wants or offers, and at what price, is a market signal (player-insight.ts).
  if (talk?.good)
    notePlayer(session, `${entry.serial}:${entry.at}:${text}`, {
      kind: 'market',
      serial: entry.serial,
      name: thread.name,
      offer: talk.side,
      good: talk.good,
      amount: talk.amount,
      price: talk.price
    });
  const intent = talk ? 'trade' : ((read?.id as Intent | undefined) ?? baseline);
  thread.turns.push({ from: 'them', text, intent, at: Date.now() });
  thread.lastAt = Date.now();
  if (intent === 'bye') {
    thread.closed = true;
    listener.quietUntil = Date.now() + QUIET_MS;
    endEngagement(session);
  }
  // A player is ignored, answered in passing, or met standing still (engagement.ts); a resident
  // on the move answers fellow residents in passing too.
  const mode = thread.peer
    ? moving(session)
      ? 'brief'
      : 'engaged'
    : consider(session, entry.serial, template.behavior.sociability, intent);
  if (mode !== 'engaged') {
    const line = mode === 'brief' ? terse(intent) : undefined;
    log(session, `${thread.name}: "${text}" -> ${intent}; ${line ? `in passing: "${line}"` : 'ignored while busy'}`);
    if (!line) return;
    await Bun.sleep(typingMs(line, true));
    if (session.phase !== 'ready') return;
    session.say(line);
    tally(session, 'speech');
    listener.lastSpoke = Date.now();
    thread.turns.push({ from: 'me', text: line, intent, reply: 'in-passing', at: Date.now() });
    return;
  }
  const facts = {
    name: thread.name,
    activity: activityLine(checkpoint),
    warm: template.behavior.sociability >= 0.5,
    answer: await worldAnswer(listener.options, intent, thread.name, text, here)
  };
  const { options, baseline: replyBaseline } = replyOptions(intent, thread, facts);
  const pick =
    decisions && options.length > 1
      ? await decisions.choose({
          kind: 'speech-reply',
          checkpoint,
          observationRevision: session.world.revision,
          state: {
            heard: text,
            understoodAs: intent,
            speaker: thread.name,
            speakerIsResident: thread.peer,
            conversationSoFar: recent,
            turns: thread.turns.length,
            resumedAfterPause: thread.resumed
          },
          candidates: options.map((option) => ({
            id: option.id,
            description: option.text ? `${option.description} Says: "${option.text}"` : option.description,
            valid: () => true
          })),
          baseline: replyBaseline,
          stillCurrent: () => session.phase === 'ready'
        })
      : null;
  const chosen = options.find((option) => option.id === (pick?.id ?? replyBaseline)) ?? options[0];
  log(
    session,
    `${thread.name}${thread.peer ? ' (resident)' : ''}: "${text}" -> ${intent}${read && intent !== baseline ? ` (rule: ${baseline})` : ''}; reply ${chosen?.id ?? 'none'}${chosen?.text ? `: "${chosen.text}"` : ''}`
  );
  if (chosen?.closes) {
    thread.closed = true;
    listener.quietUntil = Date.now() + QUIET_MS;
  }
  if (chosen?.text) {
    // The chosen reply in the resident's own voice (Claude, when enabled); exact repeats stay exact.
    const me = session.world.entities.get(session.world.serial ?? -1)?.name ?? 'resident';
    const { line, phrased } =
      chosen.id === 'repeat-last'
        ? { line: chosen.text, phrased: false }
        : await phrase({
            resident: me,
            authored: chosen.text,
            meaning: chosen.description,
            heard: text,
            speaker: thread.name,
            recent
          });
    if (phrased) log(session, `phrased "${chosen.text}" as "${line}"`);
    // Typing time for the line, and never two lines within 2.5 s.
    await Bun.sleep(typingMs(line, moving(session)) + Math.max(0, listener.lastSpoke + 2500 - Date.now()));
    if (session.phase !== 'ready') return;
    session.say(line.slice(0, 200));
    tally(session, 'speech');
    listener.lastSpoke = Date.now();
    thread.turns.push({ from: 'me', text: line, intent, reply: chosen.id, at: Date.now() });
    thread.lastAt = Date.now();
  }
  for (const decision of [read, pick])
    if (decision) decisions?.finish(checkpoint, decision, 'completed', `Heard "${text.slice(0, 40)}" as ${intent}`);
  const previous = checkpoint.relationships[thread.name];
  checkpoint.relationships[thread.name] = {
    ...previous,
    affinity: Math.min(1, (previous?.affinity ?? 0) + (intent === 'bye' || intent === 'chatter' ? 0 : 0.02)),
    note: `Talked with me (${intent}) near ${here.x},${here.y}`,
    seen: previous?.seen ?? 1,
    lastSeen: new Date().toISOString()
  };
  checkpoint.memories = [
    ...checkpoint.memories.slice(-49),
    {
      at: new Date().toISOString(),
      text: `${thread.name} said "${text.slice(0, 80)}"${chosen?.text ? `; I answered "${chosen.text}"` : ''}`
    }
  ];
}
