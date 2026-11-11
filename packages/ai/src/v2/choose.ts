import { shopPrices } from '@gemwright/common/game/rules';

import type { Outcome } from './beliefs';
import type { Traits } from './traits';

// A thing's worth in gold: what a vendor would pay for it (gold is itself).
const worths = new Map<string, number>();
export const worth = (name: string) => {
  const known = worths.get(name);
  if (known !== undefined) return known;
  const found = priced(name);
  worths.set(name, found);
  return found;
};
// Ore no vendor buys is worth the ingots a forge makes of it, one for one (ServUO Ore.cs).
const priced = (name: string) =>
  name === 'Gold'
    ? 1
    : (name
        .split('/')
        .map((type) => shopPrices(type).pays || shopPrices(type.replace(/Ore$/, 'Ingot')).pays)
        .find((pays) => pays > 0) ?? 0);
export const goods = (o: Outcome) =>
  Object.entries(o.gained).reduce((sum, [name, n]) => sum + worth(name) * n, 0) -
  Object.entries(o.lost).reduce((sum, [name, n]) => sum + worth(name) * n, 0);

// How much an attempt serves the life goal (stronger, richer, through its trade, without dying) for
// this resident, in seconds of its own usual progress: gold over what it usually earns a second,
// skill over what it usually gains a second, a death as all it carries, less the seconds it takes.
// Only the skills of its trade make it stronger; earnings from any activity can fund its trade.
// Traits weight gold, skill and death. Without a trade, every skill and every coin counts.
export function value(
  o: Outcome,
  traits: Traits,
  usual: { gold: number; skill: number },
  carried: number,
  trade?: ReadonlySet<string>
) {
  const taught = Object.entries(o.skills ?? {});
  const own = trade ? taught.filter(([skill]) => trade.has(skill)).reduce((sum, [, v]) => sum + v, 0) : o.skill;
  const richer = goods(o) / usual.gold;
  const stronger = own / usual.skill;
  const dying = (o.died * carried) / usual.gold;
  return (1 + traits.greed) * richer + (1 + traits.diligence) * stronger - (2 - traits.boldness) * dying - o.seconds;
}

// What it usually gains a second over all its attempts (in its trade's skills, when it has one),
// starting from a fair guess counted as ten minutes lived: a coin a second, and a skill point every
// hundred seconds (ServUO teaches a tenth of a point at a time, a few times a minute). Without that,
// its first few coins over its first minute would make every coin worth a minute.
const guessed = { seconds: 600, gold: 1, skill: 0.01 };
export function usual(outcomes: Iterable<Outcome>, trade?: ReadonlySet<string>) {
  let gold = guessed.gold * guessed.seconds;
  let skill = guessed.skill * guessed.seconds;
  let seconds = guessed.seconds;
  for (const o of outcomes) {
    gold += Math.max(0, goods(o));
    skill += trade
      ? Object.entries(o.skills ?? {}).reduce((sum, [name, v]) => sum + (trade.has(name) ? v : 0), 0)
      : o.skill;
    seconds += o.seconds;
  }
  return { gold: gold / seconds, skill: skill / seconds };
}

// Picking up what is not its own, from the ground or from anyone's but a creature it saw die (or its
// own corpse), is taking: an honest resident counts what it takes for as little as it is honest.
export function honestly(key: string, o: Outcome, traits: Traits): Outcome {
  const head = key.split(' > ')[0] ?? key;
  if (!head.startsWith('pick-up ')) return o;
  const object = head.slice('pick-up '.length);
  if (object.startsWith('my ') || / in (my Corpse|Corpse of \S)/.test(object)) return o;
  const kept = 1 - traits.honesty;
  return { ...o, gained: Object.fromEntries(Object.entries(o.gained).map(([name, n]) => [name, n * kept])) };
}
