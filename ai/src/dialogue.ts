// Conversation threads and authored replies, free of any session: what a line means (intent), who
// it continues (thread), and which truthful replies are legal. conversation.ts hears and speaks;
// Jev (when configured) reads the intent and picks among the replies offered here.
export type Intent =
  | 'greet'
  | 'doing'
  | 'where'
  | 'help'
  | 'follow'
  | 'wait'
  | 'trade'
  | 'acknowledge'
  | 'clarify'
  | 'bye'
  | 'chatter';

export const intents: Record<Intent, { pattern?: RegExp; description: string }> = {
  where: {
    pattern:
      /where(?:'s| is| are)? (?:the |a |an )?(bank|healer|smith|blacksmith|stables?|moongate|gate|mines?|graveyard|cemetery)/i,
    description: 'Asks where a town service or place is.'
  },
  clarify: {
    pattern:
      /^\s*(?:what\??|huh\??|eh\??|pardon(?: me)?\??|excuse me\??|sorry\??|come again\??|say that again|what did you say|what saidst thou)\W*$/i,
    description: 'Asks to hear the last thing said again ("what?", "pardon?"). Not for nonsense, remarks or greetings.'
  },
  doing: {
    pattern:
      /what (?:are|r) (?:you|u) (?:doing|up to)|what (?:dost|art) thou (?:do|doing)|what brings (?:thee|you)|\bwyd\b|what'?s up|\band (?:you|u|thou)\b\??|how about (?:you|thee)|busy\b/i,
    description: 'Asks what the listener is doing, or turns the same question back on them ("and you?").'
  },
  help: {
    pattern: /\b(?:help me|can you help|need (?:some )?help|assist me)\b/i,
    description: 'Asks the listener for help or assistance.'
  },
  follow: {
    pattern: /\b(?:follow me|come with me|come along)\b/i,
    description: 'Asks the listener to follow or come along somewhere.'
  },
  bye: {
    pattern:
      /\b(?:bye|farewell|see (?:you|ya)|take care|safe travels|good ?night|stop talking|enough|quiet|shut up|leave me alone|go away|not now)\b/i,
    description: 'Ends the conversation: says goodbye, or asks the listener to stop talking or leave them alone.'
  },
  // A bare "stop" or "wait" asks the listener to stop walking, not to stop talking.
  wait: {
    pattern: /^\W*(?:stop|wait|hold on|hang on|hold up|one moment|a moment)\b/i,
    description: 'Asks the listener to stop walking and wait ("stop", "wait", "hold on").'
  },
  trade: {
    // "vendor buy" and "vendor sell" are said to NPC shopkeepers, not to traders.
    pattern:
      /\b(?:trade|(?<!vendor )buy|(?<!vendor )sell|wares|wtb|wts|what (?:do|dost) (?:you|thou) (?:have|sell)|what are you selling)\b/i,
    description: 'Wants to trade: asks what the listener sells or offers to buy or sell something.'
  },
  acknowledge: {
    pattern:
      /^\s*(?:thanks?|thank (?:you|thee)|ty|ok(?:ay)?|good|great|nice|fair enough|i see|right|sure|aye|nay|yes|no|nope|not a problem)\b/i,
    description: 'Thanks, agrees, or simply acknowledges what was said; expects no new answer.'
  },
  greet: {
    pattern: /\b(?:hi|hello|hail|greetings|hey|well met|good (?:morning|morrow|day|evening))\b/i,
    description: 'Greets the listener or the people around ("hi", "hey everyone", "hello?").'
  },
  chatter: {
    description: 'Small talk, remarks, questions on other topics, or nonsense; asks nothing this resident can answer.'
  }
};

export function baselineIntent(text: string): Intent {
  return (Object.entries(intents).find(([, info]) => info.pattern?.test(text))?.[0] as Intent) ?? 'chatter';
}

export interface Turn {
  from: 'me' | 'them';
  text: string;
  intent?: Intent;
  reply?: string;
  at: number;
}
export interface Thread {
  partner: number;
  name: string;
  peer: boolean;
  turns: Turn[];
  startedAt: number;
  lastAt: number;
  // The partner went quiet mid-conversation and has now come back.
  resumed: boolean;
  closed: boolean;
  // After it closed, the one brush-off a request from the same partner got.
  brushedOff?: boolean;
}

const STALE_MS = 10 * 60_000;
// After a goodbye the resident moves on: no new conversation with the same partner for a while.
export const QUIET_MS = 3 * 60_000;
const PAUSE_MS = 60_000;
export const MAX_TURNS = 8;
// Residents chatting among themselves wrap up sooner than with a player.
export const MAX_PEER_TURNS = 3;
// Stop words: the speaker wants silence, so the conversation ends without another word.
export const stopWords = /\b(?:stop(?: talking)?|enough|(?:be )?quiet|shut up|leave me alone|go away|not now)\b/i;

// The thread a line from `partner` belongs to: the open one, a resumed one after a pause, or new.
export function threadFor(
  threads: Map<number, Thread>,
  partner: number,
  name: string,
  peer: boolean,
  now = Date.now()
): Thread {
  const previous = threads.get(partner);
  if (previous && !previous.closed && now - previous.lastAt < STALE_MS) {
    previous.resumed = now - previous.lastAt > PAUSE_MS;
    return previous;
  }
  const thread: Thread = { partner, name, peer, turns: [], startedAt: now, lastAt: now, resumed: false, closed: false };
  threads.set(partner, thread);
  for (const [key, old] of threads) if (now - old.lastAt > STALE_MS) threads.delete(key);
  return thread;
}

export interface ReplyOption {
  id: string;
  description: string;
  // Undefined: stay quiet.
  text?: string;
  closes?: boolean;
}
export interface Facts {
  name: string;
  activity: string;
  warm: boolean;
  // Answers that need the world (directions, help, follow), computed by the caller.
  answer?: string;
}

const lastMine = (thread: Thread) => thread.turns.findLast((turn) => turn.from === 'me');
const said = (thread: Thread, intent: Intent) =>
  thread.turns.filter((turn) => turn.from === 'them' && turn.intent === intent).length;

// Every truthful reply to `intent` in this thread, and the local rule's choice among them.
export function replyOptions(
  intent: Intent,
  thread: Thread,
  facts: Facts
): { options: ReplyOption[]; baseline: string } {
  const { name, activity, warm, answer } = facts;
  const mine = lastMine(thread);
  const quiet: ReplyOption = { id: 'stay-quiet', description: 'Say nothing; nothing was asked of me.' };
  const wrap: ReplyOption = {
    id: 'wrap-up',
    description: 'Politely end a conversation that has run long and get back to work.',
    text: `Well, I must return to my work. Fare thee well, ${name}.`,
    closes: true
  };
  const cap = thread.peer ? MAX_PEER_TURNS : MAX_TURNS;
  if (thread.turns.filter((turn) => turn.from === 'them').length >= cap && intent !== 'bye')
    return {
      options: [wrap, { ...quiet, description: 'Let the conversation end quietly.', closes: true }],
      baseline: 'wrap-up'
    };
  // The same question twice in one conversation: answer again, noting it.
  // A returned greeting is not a repeated question, so greetings never count as asked twice.
  // Answers that depend on what was asked (directions to another place) are not repeats.
  const again =
    !['acknowledge', 'chatter', 'clarify', 'greet'].includes(intent) &&
    said(thread, intent) > 1 &&
    (answer === undefined ||
      thread.turns.some((turn) => turn.from === 'me' && turn.intent === intent && turn.text.endsWith(answer)));
  // The original answer, never an earlier "As I said" (which would nest on every repeat).
  const previously = thread.turns
    .findLast((turn) => turn.from === 'me' && turn.intent === intent)
    ?.text.replace(/^(?:As I told thee, |I said: )+/i, '');
  if (again && previously)
    return {
      options: [
        {
          id: 'repeat-patiently',
          description: 'Answer the repeated question again, noting it was asked.',
          text: `As I told thee, ${/^I\b/.test(previously) ? previously : previously.charAt(0).toLowerCase() + previously.slice(1)}`
        },
        { id: 'repeat-plainly', description: 'Simply give the same answer again.', text: previously },
        {
          id: 'tease',
          description: 'Point out good-naturedly that this was already asked.',
          text: `Thou hast asked me that already, ${name}!`
        }
      ],
      baseline: warm ? 'repeat-patiently' : 'repeat-plainly'
    };
  const welcomeBack = thread.resumed ? `Back again, ${name}? ` : '';
  switch (intent) {
    case 'greet':
      // Greeted already in this conversation: their greeting answers mine, it needs no other.
      if (thread.turns.some((turn) => turn.from === 'me' && turn.intent === 'greet'))
        return {
          options: [
            { ...quiet, description: 'Say nothing more; we have already greeted each other.' },
            { id: 'ask-after', description: 'Ask what they are up to.', text: `What brings thee here, ${name}?` },
            { id: 'yes', description: 'Answer a player greeting me again.', text: `Yes, ${name}?` }
          ],
          // A player greeting again wants attention; a resident's returned greeting needs nothing.
          baseline: thread.peer ? 'stay-quiet' : 'yes'
        };
      return {
        options: [
          { id: 'greet-back', description: 'Return the greeting briefly.', text: `${welcomeBack}Hail, ${name}.` },
          {
            id: 'greet-and-share',
            description: 'Return the greeting and say what I am doing.',
            text: `${welcomeBack}Hail, ${name}! ${activity}`
          },
          {
            id: 'greet-and-ask',
            description: 'Return the greeting and ask what they are up to.',
            text: `${welcomeBack}Hail, ${name}! What brings thee here?`
          }
        ],
        baseline: warm ? 'greet-and-share' : 'greet-back'
      };
    case 'doing':
      return {
        options: [
          { id: 'share', description: 'Say what I am doing.', text: activity },
          {
            id: 'share-and-ask',
            description: 'Say what I am doing and ask the same back.',
            text: `${activity} And thou?`
          }
        ],
        baseline:
          warm &&
          !thread.turns.some((turn) => turn.from === 'me' && /What brings thee here\?|And thou\?$/.test(turn.text))
            ? 'share-and-ask'
            : 'share'
      };
    case 'clarify':
      return mine
        ? {
            options: [
              { id: 'repeat-last', description: 'Repeat what I last said.', text: `I said: ${mine.text}` },
              { id: 'stay-quiet', description: 'Let it go.' }
            ],
            baseline: 'repeat-last'
          }
        : {
            options: [
              {
                id: 'nothing-said',
                description: 'Point out I had not said anything yet.',
                text: `I said naught, ${name}.`
              },
              quiet
            ],
            baseline: 'stay-quiet'
          };
    case 'acknowledge':
      // Acknowledging an acknowledgement loops; answer only when my last line asked something.
      return mine && /\?$/.test(mine.text)
        ? {
            options: [
              quiet,
              {
                id: 'acknowledge-back',
                description: 'Acknowledge briefly in return.',
                text: warm ? `Not a problem, ${name}.` : 'Aye.'
              }
            ],
            baseline: 'acknowledge-back'
          }
        : { options: [quiet], baseline: 'stay-quiet' };
    case 'bye':
      if (stopWords.test(thread.turns.at(-1)?.text ?? ''))
        return { options: [{ ...quiet, description: 'Fall silent as asked.', closes: true }], baseline: 'stay-quiet' };
      return {
        options: [
          {
            id: 'farewell',
            description: 'Say goodbye.',
            text: warm ? `Fare thee well, ${name}!` : 'Farewell.',
            closes: true
          },
          { ...quiet, description: 'Let them go without a word.', closes: true }
        ],
        baseline: 'farewell'
      };
    case 'wait':
      return {
        options: [{ id: 'wait', description: 'Stop and ask what they want.', text: `Aye, ${name}? What is it?` }],
        baseline: 'wait'
      };
    case 'trade':
      return answer
        ? { options: [{ id: 'quote', description: 'Say what I can trade.', text: answer }], baseline: 'quote' }
        : { options: [quiet], baseline: 'stay-quiet' };
    case 'chatter':
      return {
        options: [
          quiet,
          {
            id: 'ask-meaning',
            description: 'Ask what they mean, if the remark seemed meant for me.',
            text: `Begging thy pardon, ${name}, but I know not what thou meanest.`
          }
        ],
        baseline: 'stay-quiet'
      };
    default:
      // where, help and follow carry their answer from the caller (directions, advice, a refusal).
      return answer
        ? {
            options: [{ id: 'answer', description: 'Give the answer.', text: `${welcomeBack}${answer}` }],
            baseline: 'answer'
          }
        : { options: [quiet], baseline: 'stay-quiet' };
  }
}
