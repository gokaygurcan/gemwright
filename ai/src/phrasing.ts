import Anthropic from '@anthropic-ai/sdk';

// Optional phrasing of authored replies by Claude Haiku 5.5. Jev (or the local rule) has already
// chosen what to say; the model only says it in the resident's own voice. A rephrasing is spoken
// only if it keeps every number and proper name of the authored line and adds none, makes no new
// promise, and stays one short line. Anything else, a slow answer, a missing key or an exhausted
// budget keeps the authored line.
const MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 2500;
const PER_HOUR = 120;

let client: Anthropic | null = null;
export function enablePhrasing(enabled: boolean) {
  client = enabled && process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 }) : null;
  if (enabled && !client) console.error('[phrasing] ANTHROPIC_API_KEY is not set; residents use authored lines');
  return client !== null;
}
export const phrasingEnabled = () => client !== null;

// Long enough (over 512 tokens) to be cached: every resident shares this prefix, so after the first
// request it is read from cache at a tenth of the input price.
const SYSTEM = `You voice a resident of Britannia in Ultima Online: an ordinary adventurer, craftsman or traveller talking to someone nearby, never a narrator and never an assistant.

You receive JSON with: speaker (who spoke to this resident), heard (their line), conversationSoFar (the last few lines), whatTheReplyDoes (the purpose of the reply), and authoredLine (the reply already chosen). Rephrase authoredLine so it sounds like this person talking.

Voice. Speak the way the game's own townsfolk do: plain, short sentences with a light touch of "thee", "thou" and "thy" where they fall naturally, and ordinary words otherwise. Examples of that voice, from the game itself:
- "Greetings. What might I do for thee?"
- "Fare thee well."
- "Thank thee kindly!"
- "I know not where to find that."
- "I am too busy fighting to deal with thee!"
- "If 'twere in my capabilities to help thee, I surely would."
- "Thou shouldst find it North and East of Britain."
- "Begging thy pardon, but I fail to understand what it is that thou wantest."
- "I'm doing relatively well."
Avoid heavy archaism ("prithee", "forsooth", "hath", "verily"), modern slang, emoji and exclamation overload. Vary the wording rather than repeating the authored line verbatim, but keep its tone: a farewell stays a farewell, a refusal stays a refusal, a question stays a question.

Facts. Keep every fact of authoredLine exactly: names, numbers, paces, compass directions, places, the activity described. Add nothing: no new names, places, numbers, items, reasons, feelings presented as facts, or offers. Never promise or offer to do anything (follow, escort, fetch, trade, teach) that authoredLine does not already offer. If authoredLine refuses, refuse.

Format. Reply with the single spoken line only: no quotation marks, no speaker label, no stage directions or asterisks, no explanation, at most 140 characters. If you cannot improve the line without breaking these rules, return authoredLine unchanged.`;

const uses = new Map<string, number[]>();
// Accepted rephrasings per authored line; once three exist they are reused without a request.
const variants = new Map<string, string[]>();
const REUSE_AFTER = 3;
const usage = { requests: 0, reused: 0, rejected: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
// Claude Haiku 5.5: $0.10 / 1M input, cache reads at a tenth, $0.50 / 1M output.
export const phrasingUsage = () => ({
  ...usage,
  estimatedUsd: Number(
    ((usage.inputTokens * 0.1 + usage.cachedTokens * 0.01 + usage.outputTokens * 0.5) / 1_000_000).toFixed(5)
  )
});
const promise = /\b(?:i will|i'll|i shall|let me|follow (?:thee|you)|i can (?:take|bring|show|lead))\b/i;
const numbers = (text: string): string[] => text.match(/\d+/g) ?? [];
// Capitalised words that are not the first of a sentence: names and places to keep.
const names = (text: string) =>
  [...text.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z']+(?:\s[A-Z][a-z']+)*)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => !['I', 'Thee', 'Thou', 'Thy'].includes(name));

// Why a rephrasing cannot be spoken, or undefined when it can.
export function rejection(authored: string, phrased: string): string | undefined {
  if (!phrased || phrased.length > 160 || /[\n<>*]/.test(phrased)) return 'not one short line';
  const lower = phrased.toLowerCase();
  const lost = numbers(authored).find((n) => !numbers(phrased).includes(n));
  if (lost) return `lost the number ${lost}`;
  const added = numbers(phrased).find((n) => !numbers(authored).includes(n));
  if (added) return `added the number ${added}`;
  // People (two-word names) may be called by their first name ("Jasper" for Jasper Marsh); places keep every word.
  const dropped = names(authored).find(
    (name) =>
      !lower.includes(name.toLowerCase()) &&
      !(name.split(' ').length === 2 && lower.includes(`${name.split(' ')[0]?.toLowerCase()}`))
  );
  if (dropped) return `dropped the name ${dropped}`;
  const invented = names(phrased).find((name) => !authored.toLowerCase().includes(name.toLowerCase()));
  if (invented) return `added the name ${invented}`;
  if (promise.test(phrased) && !promise.test(authored)) return 'made a promise';
  return undefined;
}
export const acceptable = (authored: string, phrased: string) => rejection(authored, phrased) === undefined;

export async function phrase(options: {
  resident: string;
  authored: string;
  meaning: string;
  heard: string;
  speaker: string;
  recent: string[];
}): Promise<{ line: string; phrased: boolean }> {
  const fallback = { line: options.authored, phrased: false };
  if (!client) return fallback;
  const known = variants.get(options.authored) ?? [];
  if (known.length >= REUSE_AFTER) {
    usage.reused++;
    return { line: known[Math.floor(Math.random() * known.length)] ?? options.authored, phrased: true };
  }
  const now = Date.now();
  const recentUses = (uses.get(options.resident) ?? []).filter((at) => now - at < 3_600_000);
  if (recentUses.length >= PER_HOUR) return fallback;
  uses.set(options.resident, [...recentUses, now]);
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
            whatTheReplyDoes: options.meaning,
            authoredLine: options.authored
          })
        }
      ]
    });
    usage.requests++;
    usage.inputTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    usage.cachedTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.outputTokens += response.usage.output_tokens;
    if (response.stop_reason !== 'end_turn') return fallback;
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join(' ')
      .trim()
      .replace(/^["'“]+|["'”]+$/g, '');
    const reason = rejection(options.authored, text);
    if (reason) {
      usage.rejected++;
      console.error(`[phrasing] kept "${options.authored}"; "${text}" ${reason}`);
      return fallback;
    }
    if (!known.includes(text)) variants.set(options.authored, [...known, text]);
    return { line: text, phrased: true };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('[phrasing] the Anthropic API key was rejected; residents use authored lines');
      client = null;
    }
    return fallback;
  }
}
