import { canPause } from './action-purpose';
import { notePlayer, tally } from './activity';
import { commitmentConversation } from './commitments';
import { worldAnswer } from './conversation-answers';
import { activityLine, factSheet, needsReply, planLine } from './conversation-facts';
import type { Listener } from './conversation-types';
import { baselineIntent, type Intent, intents, QUIET_MS, replyOptions, type Thread } from './dialogue';
import { consider, endEngagement, moving, terse, typingMs } from './engagement';
import { info } from './log';
import { orderConversation } from './order-conversation';
import { updatePersonalGoals } from './personal-goals';
import { personalVoice } from './personal-voice';
import { phrase } from './phrasing';
import { readTradeTalk } from './player-trade';
import type { PlayerSession } from './protocol/session';
import type { JournalEntry } from './protocol/world';
import { rememberPartner, sharedMemoryLine } from './resident-memory';
import { respond } from './respond';

const log = (session: PlayerSession, text: string) =>
  info(`[talk:${session.world.entities.get(session.world.serial ?? -1)?.name ?? 'resident'}] ${text}`);

export async function answer(listener: Listener, thread: Thread, entry: JournalEntry, here: { x: number; y: number }) {
  const { session, checkpoint, template, decisions } = listener.options;
  if (!canPause(session)) return;
  const text = (entry.text ?? '').slice(0, 160);
  rememberPartner(checkpoint, {
    partner: entry.serial,
    name: thread.name,
    kind: 'conversation',
    detail: 'Spoke together nearby',
    id: `conversation:${entry.serial}:${entry.at}:${text}`
  });
  const taskReply =
    orderConversation(session, entry.serial, thread.name, text) ??
    commitmentConversation(session, entry.serial, thread.name, text);
  const remembered =
    baselineIntent(text) === 'greet' && !thread.turns.some((turn) => turn.from === 'me')
      ? sharedMemoryLine(checkpoint, entry.serial)
      : undefined;
  const goal = /\b(?:saving for|working toward|your goal|thy goal|what.*aim)\b/i.test(text)
    ? updatePersonalGoals({ session, checkpoint, template })
    : undefined;
  const direct = taskReply ?? remembered ?? (goal ? `My plan is to ${goal.description.toLowerCase()}.` : undefined);
  if (direct) {
    thread.turns.push({ from: 'them', text, intent: baselineIntent(text), at: Date.now() });
    await Bun.sleep(typingMs(direct, moving(session)));
    if (!canPause(session) || session.phase !== 'ready') return;
    session.say(direct);
    thread.turns.push({ from: 'me', text: direct, intent: baselineIntent(text), at: Date.now(), reply: 'personal' });
    thread.lastAt = Date.now();
    listener.lastSpoke = Date.now();
    listener.options.persist?.();
    return;
  }

  const recent = thread.turns.slice(-4).map((turn) => `${turn.from === 'me' ? 'me' : thread.name}: ${turn.text}`);
  // Understanding: the pattern rule is the baseline; Jev reads the line in context.
  const baseline = baselineIntent(text);
  // Jev takes at most eight candidates: the core seven, and the rule's reading (or "acknowledge").
  const core: Intent[] = ['greet', 'doing', 'plans', 'needs', 'trade', 'bye', 'chatter'];
  const candidates: Intent[] = [...core, core.includes(baseline) ? 'acknowledge' : baseline];
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
  let intent: Intent = talk ? 'trade' : ((read?.id as Intent | undefined) ?? baseline);
  // A player's line beyond exact trade, directions, waiting and goodbyes: Haiku reads it and answers
  // from the resident's real situation (respond.ts), or hands it back to the authored replies.
  let said: string | undefined;
  if (!thread.peer && !['trade', 'where', 'wait', 'bye', 'follow'].includes(intent)) {
    // A need mentioned once in this conversation is not raised again unless asked about.
    const sheet = factSheet(session, checkpoint, template, listener.options.city);
    const mentioned = thread.turns.filter((turn) => turn.from === 'me').map((turn) => turn.text.toLowerCase());
    if (intent !== 'needs')
      sheet.needs = sheet.needs.filter((need) => !mentioned.some((line) => line.includes(need.split(':')[0] ?? need)));
    const reading = await respond({
      facts: sheet,
      heard: text,
      speaker: thread.name,
      recent
    });
    if (reading?.reading === 'answer') said = reading.reply;
    else if (reading) intent = reading.reading;
  }
  thread.turns.push({ from: 'them', text, intent, at: Date.now() });
  thread.lastAt = Date.now();
  if (intent === 'bye') {
    thread.closed = true;
    listener.quietUntil = Date.now() + QUIET_MS;
    endEngagement(session);
  }
  // A player is answered in passing or met standing still (engagement.ts); a resident
  // on the move answers fellow residents in passing too.
  const mode = thread.peer
    ? moving(session)
      ? 'brief'
      : 'engaged'
    : consider(session, entry.serial, template.behavior.sociability, intent);
  if (mode !== 'engaged') {
    // In passing: Haiku's answer, else the real plans or needs, else a word or two.
    const line =
      said ??
      (intent === 'plans'
        ? planLine(checkpoint)
        : intent === 'needs'
          ? needsReply(session, checkpoint, template)
          : terse(intent));
    log(session, `${thread.name}: "${text}" -> ${intent}; ${line ? `in passing: "${line}"` : 'ignored while busy'}`);
    if (!line) return;
    await Bun.sleep(typingMs(line, true));
    if (session.phase !== 'ready' || !canPause(session)) return;
    session.say(personalVoice(session, line));
    tally(session, 'speech');
    listener.lastSpoke = Date.now();
    thread.turns.push({ from: 'me', text: line, intent, reply: 'in-passing', at: Date.now() });
    return;
  }
  if (said) {
    log(session, `${thread.name}: "${text}" -> ${intent}; answered: "${said}"`);
    await Bun.sleep(typingMs(said, moving(session)) + Math.max(0, listener.lastSpoke + 2500 - Date.now()));
    if (session.phase !== 'ready' || !canPause(session)) return;
    session.say(personalVoice(session, said).slice(0, 200));
    tally(session, 'speech');
    listener.lastSpoke = Date.now();
    thread.turns.push({ from: 'me', text: said, intent, reply: 'haiku', at: Date.now() });
    thread.lastAt = Date.now();
    if (read) decisions?.finish(checkpoint, read, 'completed', `Read "${text.slice(0, 40)}" as ${intent}`);
    return;
  }
  const facts = {
    name: thread.name,
    activity: activityLine(checkpoint),
    warm: template.behavior.sociability >= 0.5,
    answer: await worldAnswer(listener.options, intent, thread.name, text, here),
    plans: planLine(checkpoint),
    needs: needsReply(session, checkpoint, template)
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
    if (session.phase !== 'ready' || !canPause(session)) return;
    session.say(personalVoice(session, line).slice(0, 200));
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
