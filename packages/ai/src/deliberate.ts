import type { Beliefs, Outcome } from './beliefs';
import { empty, round, scale } from './beliefs';
import { honestly, usual, value, worth } from './choose';
import type { Fight } from './fight';
import type { HistoryEvent } from './history';
import type { Things } from './things';
import type { Traits } from './traits';
import type { Steps, Ventures } from './ventures';

export interface Deliberation {
  beliefs: Beliefs;
  things: Things;
  fight: Fight;
  ventures: Ventures;
  where: HistoryEvent['where'];
  health: number | null;
  traits: Traits;
  trade?: ReadonlySet<string>;
  expected: (key: string) => { outcome?: Outcome };
  // What the market was last seen to pay for what an attempt brings (the wiki's prices until then).
  market?: (name: string) => number;
  steps?: Steps;
  // Where it may go (the cities it is kept to).
  allowed?: (p: { x: number; y: number }) => boolean;
}

export function* journeys({ where, fight, health, ventures, things, steps, allowed }: Deliberation) {
  if (!where) return;
  const forecasts = new Map<string, ReturnType<Fight['foresee']>>();
  for (const venture of ventures.ahead(
    where,
    new Set(),
    (name) => [...things.owned.values()].some((item) => item.name === name),
    steps,
    allowed
  )) {
    if (!venture.key.startsWith('attack ')) continue;
    if (!forecasts.has(venture.key)) forecasts.set(venture.key, fight.foresee(venture.key.slice(7), health));
    const expected = forecasts.get(venture.key);
    if (expected) yield { ...venture, expected: scale({ ...empty(), ...expected }, venture.chance) };
  }
}

export function consider({
  beliefs,
  things,
  fight,
  ventures,
  where,
  health,
  traits,
  trade,
  expected,
  market,
  steps
}: Deliberation) {
  const present = new Set(['self']);
  for (const serial of things.names.keys()) present.add(things.thing(serial) ?? '');
  const keys = new Set<string>();
  for (const key of beliefs.keys()) {
    const head = key.split(' > ')[0] ?? key;
    const verb = head.split(' ')[0] ?? head;
    const object = head.slice(verb.length + 1).split(': ')[0] ?? '';
    if (!object || verb === 'text-command' || verb === 'speech' || present.has(object)) keys.add(key);
  }
  for (const serial of things.mobiles) {
    const name = things.names.get(serial);
    if (name && fight.isCreature(name)) keys.add(`attack ${name}`);
  }
  const rates = usual([beliefs.lived], trade);
  const carried = [...things.owned.values()].reduce((sum, item) => sum + worth(item.name) * item.amount, 0);
  const options: { key: string; value: number; seconds?: number }[] = [{ key: 'rest', value: 0 }];
  for (const key of keys) {
    const { outcome } = expected(key);
    if (outcome)
      options.push({
        key,
        value: round(value(honestly(key, outcome, traits), traits, rates, carried, trade, market))
      });
  }
  // Or going somewhere to do something: the walk there counts as time.
  for (const venture of where
    ? ventures.ahead(where, keys, (name) => [...things.owned.values()].some((item) => item.name === name), steps)
    : []) {
    const outcome = venture.key.startsWith('attack ')
      ? fight.foresee(venture.key.slice(7), health)
      : expected(venture.key).outcome;
    if (!outcome) continue;
    // What it would find there, as likely as finding it, and the walk whatever it finds.
    const going = scale({ ...empty(), ...outcome }, venture.chance);
    going.seconds += venture.walk;
    options.push({
      key: `go ${venture.where.x},${venture.where.y}: ${venture.key}`,
      value: round(value(going, traits, rates, carried, trade, market)),
      seconds: going.seconds
    });
  }
  return options.sort((a, b) => b.value - a.value);
}
