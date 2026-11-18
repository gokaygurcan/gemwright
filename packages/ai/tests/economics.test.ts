import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { HistoryEvent } from '../src/history';
import { live } from '../src/live';
import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import { traitsOf } from '../src/traits';
import { startShard } from './fixtures/crafting-shard';
import { recorded } from './fixtures/resident-run';

const CRAFT = /gump-response/;
const SELL = /^sell /;

// Two successes in three, for as long as the resident keeps trying: bad luck and good take turns,
// so a failure is never evidence that the work has stopped paying. Deterministic for the test,
// uncertain in experience.
const successes = Array.from({ length: 60 }, (_, index) => index % 3 !== 2);

// The workshop's economics: the hammer wears with each attempt; the vendor (a smith, an armorer
// and a miner) buys both raw ingots and the crafted work throughout. The shop first pays well for
// the work, then its price for it collapses — the same resident's life, one market that changed.
const recipe = {
  anvil: { x: 105, y: 100, z: 0 },
  hammer: 5091,
  gump: 42,
  button: 21,
  itemType: 'StuddedChest',
  itemGraphic: 5083,
  itemPrice: 90,
  ingotsPerCraft: 5,
  successes,
  hammerUses: 20,
  skillGainTenths: 1
};

const carried = (items: Record<string, number> = {}, type: string) =>
  Object.entries(items)
    .filter(([name]) => name.split('/').includes(type))
    .reduce((total, [, amount]) => total + amount, 0);

test('the resident keeps crafting through bad luck, then turns to selling raw when the market for the work collapses', async () => {
  // A first life on a shop that takes only the work, so the hammer's menu can be found at all (a
  // profitable ingot market always outbids a first, unmeasured look at a tool).
  const learning = startShard({ coldAfterFirstSale: false, vendors: ['Armorer', 'Miner'], blacksmithing: recipe });
  // The life this test is about: from its start, the shop takes raw ingots as well as the work.
  const shop = startShard({
    coldAfterFirstSale: false,
    vendors: ['Blacksmith', 'Armorer', 'Miner'],
    blacksmithing: recipe
  });

  const events: HistoryEvent[] = [];
  const push = (event: HistoryEvent) => {
    events.push(event);
  };
  const { traits } = traitsOf([], () => 0.5);
  const mind = new Mind('resident', push, traits, [], ['Mining']);
  mind.acting = true;
  const play = async (shard: typeof shop, stopWhen: () => boolean) => {
    const stopPerception = perceive(
      shard.session as unknown as PlayerSession,
      'resident',
      (event) => {
        push(event);
        mind.observe(event);
      },
      shard.landAt
    );
    try {
      await live(shard.session as unknown as PlayerSession, mind, shard.terrain, shard.places, stopWhen, (kind, data) =>
        push({ resident: 'resident', at: Date.now(), kind, data })
      );
    } finally {
      stopPerception();
    }
  };

  const crafts = () =>
    recorded(events).filter((entry) => entry.kind === 'outcome' && CRAFT.test(String(entry.data.key ?? '')));
  const failures = () =>
    crafts().filter(
      (entry) =>
        carried(entry.data.observed?.gained, recipe.itemType) === 0 &&
        carried(entry.data.observed?.lost, 'IronIngot') >= recipe.ingotsPerCraft
    );
  const chestSales = () =>
    recorded(events).filter(
      (entry) =>
        entry.kind === 'outcome' &&
        SELL.test(String(entry.data.key ?? '')) &&
        carried(entry.data.observed?.lost, recipe.itemType) >= 1
    );
  // What the shop's sell list named the work at, as the resident read it: how it learns the market.
  const listedAt = (chestPrice: number) =>
    recorded(events).find(
      (entry) =>
        entry.kind === 'sell' &&
        Array.isArray(entry.data.value) &&
        entry.data.value.some((offer) => offer.graphic === recipe.itemGraphic && offer.price === chestPrice)
    );
  // A sale that paid the work at a given price a chest, and the ingots at the vendor's ingot price.
  const paidAt = (entry: ReturnType<typeof chestSales>[number], chestPrice: number) =>
    (entry.data.observed?.gained?.Gold ?? 0) ===
    carried(entry.data.observed?.lost, recipe.itemType) * chestPrice +
      carried(entry.data.observed?.lost, 'IronIngot') * 4;

  // Life one: discovery, and one working recipe.
  const learningStarted = Date.now();
  await play(learning, () => crafts().length > 0 || Date.now() - learningStarted > 20_000);

  // Life two: both routes from the start, mixed luck, then a changed market.
  let flipped = false;
  let restocked = false;
  const lifeStarted = Date.now();
  await play(shop, () => {
    if (!flipped) {
      // The price collapses at the quiet moment a sale has just ended, with no work carried over, so
      // the next sale is the first to meet the new market — and the one that reveals it.
      const current = recorded(events);
      const last = current.at(-1);
      const failed = failures();
      const recovered = crafts().some(
        (entry) =>
          failed.length > 0 &&
          entry.index > (failed[0]?.index ?? 0) &&
          carried(entry.data.observed?.gained, recipe.itemType) >= 1
      );
      if (
        last?.kind === 'plan-ended' &&
        SELL.test(String(last.data.key ?? '')) &&
        failed.length > 0 &&
        recovered &&
        chestSales().length >= 2 &&
        shop.state().crafted === 0
      ) {
        // The market collapses, and the observer sets out a fresh tool and metal for the life after
        // it: the question is what the resident makes of the new market, not whether it is solvent.
        shop.price(4);
        shop.restock(12);
        flipped = true;
      }
      return false;
    }
    const current = recorded(events);
    // Reading the shop's list after the collapse is how it comes to know the new price. With that
    // known, the observer sets out another pile, so both routes have materials to be weighed with.
    const revealed = listedAt(4);
    if (!revealed) return Date.now() - lifeStarted > 200_000;
    if (!restocked) {
      shop.restock(10);
      restocked = true;
    }
    const flip = current.find((entry) => {
      if (entry.index <= revealed.index || entry.kind !== 'considered') return false;
      const options = entry.data.options ?? [];
      const sale = options.find((option) => SELL.test(option.key) && !option.key.includes(recipe.itemType));
      const craft = options.find((option) => CRAFT.test(option.key));
      return (
        sale !== undefined && craft !== undefined && SELL.test(String(entry.data.doing ?? '')) && craft.rate < sale.rate
      );
    });
    if (!flip) return Date.now() - lifeStarted > 200_000;
    // Enough once that sale is done, the raw ingots gone out with no work among them.
    return (
      current.some(
        (entry) =>
          entry.index > flip.index &&
          entry.kind === 'outcome' &&
          SELL.test(String(entry.data.key ?? '')) &&
          carried(entry.data.observed?.lost, 'IronIngot') > 0 &&
          carried(entry.data.observed?.lost, recipe.itemType) === 0
      ) || Date.now() - lifeStarted > 200_000
    );
  });

  const list = recorded(events);
  const state = shop.state();
  const failed = failures();

  // While the work paid, it kept at it through bad luck: failures came, and successes came after
  // them — what an attempt was worth stayed worth taking, so it did not walk away from the trade.
  expect(failed.length).toBeGreaterThanOrEqual(1);
  const firstFailure = failed[0];
  if (!firstFailure) throw new Error('The work never failed');
  expect(
    crafts().some(
      (entry) => entry.index > firstFailure.index && carried(entry.data.observed?.gained, recipe.itemType) >= 1
    )
  ).toBe(true);
  expect(
    list.some(
      (entry) =>
        entry.kind === 'considered' &&
        entry.index > firstFailure.index &&
        CRAFT.test(String(entry.data.doing ?? '')) &&
        (entry.data.options ?? []).some((option) => option.key === entry.data.doing && option.rate > 0)
    )
  ).toBe(true);

  // Both routes were there all along: the shop paid well for the work (chests out at the old price,
  // alongside raw ingots), and it bought ingots the whole time.
  expect(chestSales().filter((entry) => paidAt(entry, 90)).length).toBeGreaterThanOrEqual(1);

  // The market changed: by the end the shop paid 4 for the work — and the resident saw it, reading
  // the list it was offered.
  expect(state.itemPrice).toBe(4);
  const revealed = listedAt(4);
  expect(revealed).toBeDefined();
  if (!revealed) throw new Error('The new price was never seen listed');

  // It learned from it: after the collapsed price was seen it stopped working the hammer (no
  // attempt after the revealing sale, though it still had ingots to spend), and with both routes on
  // offer — another attempt, and the sale of what it carried — it took the sale.
  expect(crafts().some((entry) => entry.index > revealed.index)).toBe(false);
  const flip = list.find((entry) => {
    if (entry.kind !== 'considered' || entry.index <= revealed.index) return false;
    const options = entry.data.options ?? [];
    const sale = options.find((option) => SELL.test(option.key) && !option.key.includes(recipe.itemType));
    const craft = options.find((option) => CRAFT.test(option.key));
    return (
      sale !== undefined && craft !== undefined && SELL.test(String(entry.data.doing ?? '')) && craft.rate < sale.rate
    );
  });
  expect(flip).toBeDefined();
  if (!flip) throw new Error('The sale never won over the work with both on offer');

  // The route it turned to: ingots going out raw, with no work among them.
  const sales = list.filter((entry) => entry.kind === 'outcome' && SELL.test(String(entry.data.key ?? '')));
  expect(
    sales.some(
      (entry) =>
        entry.index > revealed.index &&
        carried(entry.data.observed?.lost, 'IronIngot') > 0 &&
        carried(entry.data.observed?.lost, recipe.itemType) === 0
    )
  ).toBe(true);

  // The hammer wore with every attempt, without this life wearing it out.
  expect(state.hammerUses).toBe(recipe.hammerUses - state.craftAttempts);
  expect(state.hammerUses).toBeGreaterThan(0);
}, 240_000);
