import { info } from './log';
import { haikuClient, names, numbers, promise, usage } from './phrasing';

// A player's line understood and answered by Claude Haiku from the resident's real situation (its
// fact sheet), for what the authored patterns cannot read: "u heading somewhere?", "need a hand?",
// "nice horse, where'd you get it?". Haiku says what the line means and replies in the resident's
// voice. A reply is spoken only if it is one short line whose numbers and names all come from the
// facts or the player's line, and that promises nothing; otherwise, or without Haiku, the authored
// replies answer (dialogue.ts). Lines that carry exact amounts or actions (trade, directions,
// waiting, goodbyes) always go back to the authored handling.
const MODEL = 'claude-haiku-5-5';

export type Reading = 'answer' | 'trade' | 'where' | 'wait' | 'bye' | 'follow';

export interface FactSheet {
  me: string;
  profession: string;
  home: string;
  doing: string;
  goingTo: string;
  needs: string[];
  carriedGold: number;
  bestSkills: string[];
  mounted?: string;
  voice?: string;
  goals?: string[];
  sharedExperiences?: string[];
}

// Long enough to be cached (over 512 tokens) and shared by every resident.
const SYSTEM = `You are a resident of Britannia in Ultima Online, an ordinary adventurer or craftsman, answering someone who just spoke to you. You are never a narrator and never an assistant.

You receive JSON: speaker (who spoke), heard (their line), conversationSoFar (recent lines, oldest first), and facts (the only true things you know about yourself: your name, trade, home town, what you are doing, where you are going, what you are short of, the gold you carry, your best skills, your mount).

First decide what the line wants:
- "trade": they want to buy, sell or trade goods.
- "where": they ask where a town service or place is (bank, healer, smith, stables, moongate, mines, cemetery).
- "wait": they ask you to stop or wait.
- "bye": they say goodbye or ask you to leave them alone.
- "follow": they ask you to come along or follow them.
- "answer": anything else: greetings, questions about you, where you are going, whether you need anything, offers, remarks, jokes. Answer these yourself.

Then, for "answer", reply as yourself in one short spoken line, from the facts only:
- Asked where you are going or what you are doing: say it from goingTo and doing.
- Asked or offered whether you need anything: name what is in needs and why, plainly, so they can bring it; if needs is empty, say you lack nothing and thank them.
- Offered a gift or help: accept warmly if it is something in needs, otherwise thank them and decline politely.
- Asked something the facts do not cover: say honestly that you do not know, or give a short opinion clearly marked as one, never an invented fact.
- Remarks and small talk: answer naturally and briefly; you may ask something back. Do not bring up your needs here unless conversationSoFar shows you have not mentioned them yet and it fits; never ask twice.
Safety and active tasks take priority over talking. Shared experiences and goals are facts only when listed; do not invent a past relationship.

Voice: follow facts.voice. For plain, use short everyday language; friendly can be warm and conversational; reserved may use the game's townsfolk voice. Plain short sentences with a light "thee", "thou", "thy" where natural ("Greetings. What might I do for thee?", "Fare thee well.", "Thank thee kindly!", "I know not where to find that."). No heavy archaism, slang, emoji or stage directions.

Rules: use only numbers and names that appear in facts or heard. Make no promises and no invitations: never say you will do, fetch, follow, teach, give or meet anything later, and never invite them to come along or walk with you. At most 140 characters.

Reply with JSON only: {"reading": "answer" | "trade" | "where" | "wait" | "bye" | "follow", "reply": "the spoken line, for answer"}`;

const uses = new Map<string, number[]>();
const PER_HOUR = 120;

// Why a reply cannot be spoken, or undefined when it can.
export function replyRejection(reply: string, facts: FactSheet, heard: string): string | undefined {
  if (!reply || reply.length > 160 || /[\n<>*]/.test(reply)) return 'not one short line';
  const known = `${JSON.stringify(facts)} ${heard}`.toLowerCase();
  const added = numbers(reply).find((n) => !numbers(known).includes(n));
  if (added) return `added the number ${added}`;
  const invented = names(reply).find((name) => !known.includes(name.toLowerCase()));
  if (invented) return `added the name ${invented}`;
  if (promise.test(reply)) return 'made a promise';
  return undefined;
}

export async function respond(options: {
  facts: FactSheet;
  heard: string;
  speaker: string;
  recent: string[];
}): Promise<{ reading: Reading; reply?: string } | undefined> {
  const client = haikuClient();
  if (!client) return undefined;
  const now = Date.now();
  const recentUses = (uses.get(options.facts.me) ?? []).filter((at) => now - at < 3_600_000);
  if (recentUses.length >= PER_HOUR) return undefined;
  uses.set(options.facts.me, [...recentUses, now]);
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            speaker: options.speaker,
            heard: options.heard,
            conversationSoFar: options.recent,
            facts: options.facts
          })
        }
      ]
    });
    usage.requests++;
    usage.inputTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    usage.cachedTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.outputTokens += response.usage.output_tokens;
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      reading?: string;
      reply?: string;
    };
    const reading = (['answer', 'trade', 'where', 'wait', 'bye', 'follow'] as const).find((r) => r === json.reading);
    if (!reading) return undefined;
    if (reading !== 'answer') return { reading };
    const reply = (json.reply ?? '').trim().replace(/^["'“]+|["'”]+$/g, '');
    const reason = replyRejection(reply, options.facts, options.heard);
    if (reason) {
      usage.rejected++;
      info(`[respond] "${options.heard}" -> "${reply}" ${reason}`);
      return { reading };
    }
    return { reading, reply };
  } catch {
    return undefined;
  }
}
