import { expect, test } from 'bun:test';

import { PICKAXE_SERIAL, startShard } from './fixtures/crafting-shard';
import { recorded, runResident } from './fixtures/resident-run';

const BUY = /^buy /;
const HARVEST = /^harvest /;
const SELL = /^sell /;
const ORE_GRAPHIC = 6584;
const pickaxeLost = (list: ReturnType<typeof recorded>) =>
  list.filter((entry) => entry.kind === 'lost' && entry.data.serial === PICKAXE_SERIAL);
// A fresh pile of ore in its pack: the only way it gets one is digging it up.
const oreGained = (list: ReturnType<typeof recorded>) =>
  list.filter((entry) => entry.kind === 'gained' && entry.data.graphic === ORE_GRAPHIC);
const buys = (list: ReturnType<typeof recorded>) =>
  list.filter((entry) => entry.kind === 'plan-ended' && BUY.test(String(entry.data.id ?? '')));
const harvests = (list: ReturnType<typeof recorded>) =>
  list.filter((entry) => entry.kind === 'plan-ended' && HARVEST.test(String(entry.data.id ?? '')));

test('a resident whose pickaxe breaks buys another when it can afford it, and mines on without any scripted recovery', async () => {
  // 1. The tool wears out, the resident sells what it has to raise the money, and the vendor's
  // pickaxe is within its means: the purchase is its own decision and mining resumes.
  const shard = startShard({ coldAfterFirstSale: false });
  const events = await runResident(shard, (list) => {
    const entries = recorded(list);
    const purchase = buys(entries).find((entry) => entry.data.result === 'completed');
    if (!purchase) return false;
    return harvests(entries).filter((entry) => entry.index > purchase.index).length >= 2;
  });

  const list = recorded(events);
  const breaks = pickaxeLost(list);
  expect(breaks.length).toBe(1);
  const brokeAt = (breaks[0] as (typeof breaks)[number]).index;

  // It noticed the tool was gone: no ore came out of the ground between the break and the purchase.
  const buy = buys(list).find((entry) => entry.data.result === 'completed');
  expect(buy).toBeDefined();
  if (!buy) throw new Error('The resident never bought a replacement');
  expect(oreGained(list).filter((entry) => entry.index > brokeAt && entry.index < buy.index)).toHaveLength(0);

  // It paid for the tool first: the sale came between the break and the purchase.
  const sale = list.find((entry) => entry.kind === 'outcome' && SELL.test(String(entry.data.key ?? '')));
  expect(sale).toBeDefined();
  if (!sale) throw new Error('The resident never sold to raise the money');
  expect(sale.index).toBeGreaterThan(brokeAt);
  expect(sale.index).toBeLessThan(buy.index);

  // It chose the purchase among what it could do, at the price the rules put on it.
  expect(
    list.some(
      (entry) => entry.kind === 'considered' && BUY.test(String(entry.data.doing ?? '')) && entry.index < buy.index
    )
  ).toBe(true);
  expect(shard.state().purchases).toBe(1);
  expect(shard.state().gold).toBe(32 - 25);

  // And it went back to its work on its own: fresh mining attempts after the new pickaxe.
  expect(harvests(list).filter((entry) => entry.index > buy.index).length).toBeGreaterThanOrEqual(2);
  expect(shard.state().breaks).toBe(1);
  expect(shard.state().sales).toBe(1);

  // 2. With less money coming in, the same worn-out tool does not lead to a purchase: the cheapest
  // mining tool the vendor sells costs more than the resident can raise, so it stays idle.
  const poor = startShard({ coldAfterFirstSale: false, ingotPrice: 1 });
  const poorEvents = await runResident(poor, (events_) => {
    const entries = recorded(events_);
    const broke = pickaxeLost(entries)[0];
    if (!broke) return false;
    const sold = entries.find(
      (entry) => entry.index > broke.index && entry.kind === 'outcome' && SELL.test(String(entry.data.key ?? ''))
    );
    if (!sold) return false;
    return entries.some(
      (entry) => entry.index > sold.index && entry.kind === 'considered' && entry.data.doing === 'rest'
    );
  });

  const poorList = recorded(poorEvents);
  const poorBreaks = pickaxeLost(poorList);
  expect(poorBreaks.length).toBe(1);
  const poorBreak = (poorBreaks[0] as (typeof poorBreaks)[number]).index;
  const poorSale = poorList.find(
    (entry) => entry.index > poorBreak && entry.kind === 'outcome' && SELL.test(String(entry.data.key ?? ''))
  );
  expect(poorSale).toBeDefined();
  expect(poor.state().purchases).toBe(0);
  expect(buys(poorList)).toHaveLength(0);
  expect(oreGained(poorList).filter((entry) => entry.index > poorBreak)).toHaveLength(0);
  expect(poor.state().gold).toBe(8);
  expect(poor.state().gold).toBeLessThan(12);
  // With the money gone short, nothing worth doing is left on offer: whatever it settles into — a
  // rest, or a curious word to whoever stands nearby — neither a purchase nor another dig is among
  // its choices.
  const settled = poorList.filter((entry) => entry.kind === 'considered').at(-1);
  expect(settled).toBeDefined();
  expect(
    (settled?.data.options ?? []).some(
      (option) => BUY.test(option.key) || /^double-click my .+ > target land/.test(option.key)
    )
  ).toBe(false);
}, 120_000);
