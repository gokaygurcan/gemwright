import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { HistoryEvent } from '../src/v2/history';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { traitsOf } from '../src/v2/traits';
import { startShard } from './fixtures/v2/crafting-shard';

// The attempts the resident learns: mining a rock with its pickaxe, smelting ore at the forge
// (the forge tile's graphic is 4017), and selling to the vendor.
const MINE_KEY = /^double-click my .* > target land\d+$/;
const SMELT_KEY = /^double-click my .* > target tile4017$/;
const SELL_KEY = /^sell /;

// What the recorded events carry, as far as this experiment reads them.
interface Recorded {
  index: number;
  kind: string;
  data: {
    key?: string;
    doing?: string;
    options?: { key: string; rate: number }[];
    observed?: { gained?: Record<string, number>; lost?: Record<string, number> };
    error?: { gained?: Record<string, number> };
    expect?: { gained?: Record<string, number> };
  };
}
const recorded = (events: HistoryEvent[]): Recorded[] =>
  events.map((event, index) => ({ index, kind: event.kind, data: event.data as Recorded['data'] }));

const ingotish = (gained: Record<string, number> = {}) =>
  Object.entries(gained)
    .filter(([name]) => name.split('/').includes('IronIngot'))
    .reduce((sum, [, n]) => sum + n, 0);
const oreish = (lost: Record<string, number> = {}) =>
  Object.entries(lost)
    .filter(([name]) => name.split('/').includes('IronOre'))
    .reduce((sum, [, n]) => sum + n, 0);

test('a resident discovers mining, smelting and selling on its own, and revises the chain when the forge goes cold', async () => {
  const shard = startShard();
  const { session, world, terrain, places, landAt } = shard;
  const events: HistoryEvent[] = [];
  let stop = false;

  // The experiment ends once the mind has met the disagreement more than once and moved past it:
  // after the forge has taken smelts it gives nothing back for and the resident has turned to
  // something else while still carrying ore.
  const revised = () => {
    const list = recorded(events);
    const outcomes = list.filter((entry) => entry.kind === 'outcome');
    const firstSell = outcomes.find((entry) => SELL_KEY.test(entry.data.key ?? ''));
    if (!firstSell) return false;
    const cold = outcomes.filter(
      (entry) =>
        SMELT_KEY.test(entry.data.key ?? '') &&
        entry.index > firstSell.index &&
        ingotish(entry.data.observed?.gained) === 0
    );
    if (cold.length < 2) return false;
    const last = cold.at(-1);
    if (!last) return false;
    return list.some(
      (entry) => entry.index > last.index && entry.kind === 'considered' && !SMELT_KEY.test(entry.data.doing ?? '')
    );
  };

  const push = (event: HistoryEvent) => {
    events.push(event);
    if (!stop && (event.kind === 'outcome' || event.kind === 'considered')) stop = revised();
  };

  const { traits } = traitsOf([], () => 0.5);
  const mind = new Mind('resident', push, traits, [], ['Mining']);
  mind.acting = true;
  const stopPerception = perceive(
    session as unknown as PlayerSession,
    'resident',
    (event) => {
      push(event);
      mind.observe(event);
    },
    landAt
  );
  mind.awake = true;
  const started = Date.now();
  try {
    await live(
      session as unknown as PlayerSession,
      mind,
      terrain,
      places,
      () => stop || Date.now() - started > 45_000,
      (kind, data) => push({ resident: 'resident', at: Date.now(), kind, data })
    );
  } finally {
    stopPerception();
  }

  const list = recorded(events);
  const outcomes = list.filter((entry) => entry.kind === 'outcome');
  const mine = outcomes.find((entry) => MINE_KEY.test(entry.data.key ?? ''));
  const smelt = outcomes.find((entry) => SMELT_KEY.test(entry.data.key ?? ''));
  const sell = outcomes.find((entry) => SELL_KEY.test(entry.data.key ?? ''));

  // It found and worked the whole chain, in order: mining brought ore, smelting brought ingots,
  // selling brought gold, and nothing told it to do any of them.
  expect(mine).toBeDefined();
  expect(smelt).toBeDefined();
  expect(sell).toBeDefined();
  if (!mine || !smelt || !sell) throw new Error('Some step of the chain never happened');
  expect(mine.index).toBeLessThan(smelt.index);
  expect(smelt.index).toBeLessThan(sell.index);
  expect(ingotish(smelt.data.observed?.gained)).toBeGreaterThanOrEqual(1);
  expect(sell.data.observed?.gained?.Gold).toBeGreaterThan(0);
  expect(ingotish(sell.data.observed?.lost)).toBeGreaterThanOrEqual(1);
  expect(shard.state().sales).toBe(1);

  // It weighed smelting before doing it: the attempt was predicted to bring ingots, and it was
  // the best thing to do when it was chosen.
  const predicted = list.filter((entry) => entry.kind === 'predicted' && SMELT_KEY.test(entry.data.key ?? ''));
  expect(predicted.length).toBeGreaterThanOrEqual(2);
  expect(list.some((entry) => entry.kind === 'considered' && SMELT_KEY.test(entry.data.doing ?? ''))).toBe(true);

  // Reality disagreed: after the sale the forge took smelts and gave nothing back.
  expect(shard.state().cold).toBe(true);
  const cold = outcomes.filter(
    (entry) =>
      SMELT_KEY.test(entry.data.key ?? '') && entry.index > sell.index && ingotish(entry.data.observed?.gained) === 0
  );
  expect(cold.length).toBeGreaterThanOrEqual(2);
  const firstCold = cold[0];
  if (!firstCold) throw new Error('The cold forge was never tried');
  expect(oreish(firstCold.data.observed?.lost)).toBeGreaterThan(0);
  expect(
    Object.entries(firstCold.data.error?.gained ?? {}).some(([name, amount]) => name.includes('Ingot') && amount < 0)
  ).toBe(true);

  // It revised: smelting's expected yield fell with each disappointed attempt, and once it had
  // seen enough it turned to something else.
  const expectations = predicted.flatMap((entry) => (entry.data.expect ? [ingotish(entry.data.expect.gained)] : []));
  expect(expectations.length).toBeGreaterThanOrEqual(2);
  expect(expectations.at(-1) as number).toBeLessThan(expectations[0] as number);
  const lastCold = cold.at(-1);
  if (!lastCold) throw new Error('The cold forge was never tried');
  const declined = list.find((entry) => entry.index > lastCold.index && entry.kind === 'considered');
  expect(declined).toBeDefined();
  if (!declined) throw new Error('No deliberation happened after the forge went cold');
  expect(SMELT_KEY.test(declined.data.doing ?? '')).toBe(false);
  expect(world.serial).not.toBeNull();
}, 90_000);
