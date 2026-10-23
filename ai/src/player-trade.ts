import type { Good } from './market';
import { haikuClient } from './phrasing';

// A player's free-form trade talk read into market terms: "wtb 50 boards", "need heal pots",
// "selling ingots 4 each", "how much for bows?". Patterns read the common shapes; when Claude
// phrasing is enabled, Haiku reads what they miss (at most 60 a process an hour, cached per line).
// `side` is the player's: buying means the resident would sell.
export interface TradeTalk {
  side: 'buying' | 'selling' | 'asking';
  good?: Good;
  amount?: number;
  // The player's price for the whole lot.
  price?: number;
}

const aliases: [RegExp, Good][] = [
  [/\b(?:boards?|planks?|wood|lumber|logs?)\b/i, 'boards'],
  [/\b(?:heal(?:ing)?|gh|lesser heal) ?(?:pots?|potions?)?\b/i, 'heal potions'],
  [/\bcure ?(?:pots?|potions?)?\b/i, 'cure potions'],
  [/\bpoison ?(?:pots?|potions?)?\b/i, 'poison potions'],
  [/\b(?:ingots?|iron|metal)\b/i, 'iron ingots'],
  [/\b(?:bows?|composite bows?|longbows?)\b/i, 'exceptional bows']
];
const buying = /\b(?:wtb|buy(?:ing)?|want(?:ing)?|need(?:ing)?|looking for|lf)\b/i;
const selling = /\b(?:wts|sell(?:ing)?|have|got)\b/i;
const asking = /\bhow much\b|\bprice\b|\bcost\b/i;

function byPattern(text: string): TradeTalk | undefined {
  const good = aliases.find(([pattern]) => pattern.test(text))?.[1];
  const side = buying.test(text)
    ? 'buying'
    : selling.test(text)
      ? 'selling'
      : asking.test(text) || (good && /\?$/.test(text))
        ? 'asking'
        : undefined;
  // A price question needs a price word; other talk needs a good ("how are you?" is not trade).
  if (!side || (!good && side !== 'asking')) return undefined;
  // A quantity is a number before a word that is not a price word ("4 each" prices, "40 boards" counts).
  const amount =
    Number(/\b(\d{1,4})\s*(?:x\s*)?(?!(?:gp|gold|g|ea|each|apiece|per)\b)[a-z]/i.exec(text)?.[1]) || undefined;
  // "4 each", "4gp ea", "@4" price a unit; "for 120 gold" prices the lot.
  const each = /(?:@\s*|\b)(\d{1,5})\s*(?:gp|gold|g)?\s*(?:ea|each|apiece|per)\b|@\s*(\d{1,5})/i.exec(text);
  const lot = /\bfor\s+(\d{1,6})\s*(?:gp|gold|g)?\b/i.exec(text);
  const unit = Number(each?.[1] ?? each?.[2]);
  const price = lot ? Number(lot[1]) : unit && amount ? unit * amount : undefined;
  return { side, good, amount, price };
}

const cache = new Map<string, TradeTalk | null>();
const calls: number[] = [];

async function byHaiku(text: string): Promise<TradeTalk | undefined> {
  const client = haikuClient();
  const now = Date.now();
  while (calls.length && now - (calls[0] ?? 0) > 3_600_000) calls.shift();
  if (!client || calls.length >= 60) return undefined;
  calls.push(now);
  const goods = aliases.map(([, good]) => good).filter((g, i, all) => all.indexOf(g) === i);
  const reply = await client.messages
    .create({
      model: 'claude-haiku-5-5',
      max_tokens: 80,
      system: `Read one line a player said in Ultima Online. If it is about trading one of these goods (${goods.join(', ')}), answer with JSON {"side":"buying"|"selling"|"asking","good":one of the goods,"amount":number|null,"price":total gold for the lot|null}. "side" is the speaker's: wanting a good is buying. Otherwise answer {"side":null}. JSON only.`,
      messages: [{ role: 'user', content: text.slice(0, 200) }]
    })
    .catch(() => undefined);
  const block = reply?.content.find((part) => part.type === 'text');
  try {
    const read = JSON.parse(block && block.type === 'text' ? block.text : '{}') as Partial<TradeTalk> & {
      side?: string;
    };
    if (!read.side || !['buying', 'selling', 'asking'].includes(read.side)) return undefined;
    const good = goods.includes(read.good as Good) ? (read.good as Good) : undefined;
    return {
      side: read.side as TradeTalk['side'],
      good,
      amount: read.amount ?? undefined,
      price: read.price ?? undefined
    };
  } catch {
    return undefined;
  }
}

export async function readTradeTalk(text: string): Promise<TradeTalk | undefined> {
  const key = text.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const read = byPattern(key) ?? (await byHaiku(key));
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  cache.set(key, read ?? null);
  return read;
}
