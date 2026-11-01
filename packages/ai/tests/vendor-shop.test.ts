import { expect, test } from 'bun:test';

import { ActionBusy } from '../src/action-errors';
import { buyOffers, sellChosen, sellOffers } from '../src/vendor-shop';
import { behaviorFixture, required } from './behavior-fixture';

test('a sale is what the gold confirms, and a busy resource is not a vendor that buys nothing', async () => {
  const { session, world } = behaviorFixture();
  const offer = { serial: 40, graphic: 0x1bdd, hue: 0, amount: 5, price: 3, name: 'boards' };
  session.waitFor = async (ready) => {
    if (!ready()) throw new Error('timeout');
  };
  session.context = async () => {
    throw new ActionBusy('Command resources remained busy');
  };
  expect(await sellOffers(session, 2, 3006104)).toEqual({ why: 'busy' });
  session.context = async () => [{ index: 0, cliloc: 3006104, flags: 0 }];
  session.selectContext = () => {
    world.sellOffers.set(2, [offer]);
  };
  const opened = await sellOffers(session, 2, 3006104);
  expect(opened).toEqual({ offers: [offer] });
  session.refreshStatus = async () => {};
  session.sell = async () => {};
  expect(await sellChosen(session, 2, [offer])).toEqual({ amount: 5, earned: 0 });
  session.sell = async () => {
    required(world.status).gold += 15;
  };
  expect((await sellChosen(session, 2, [offer])).earned).toBe(15);
});

test("a vendor's stock opens through its Buy entry, and a stock list that never comes is named, not taken for empty", async () => {
  const { session, world } = behaviorFixture();
  session.waitFor = async (ready) => {
    if (!ready()) throw new Error('timeout');
  };
  session.context = async () => [{ index: 0, cliloc: 3006103, flags: 0 }];
  session.selectContext = () => {};
  expect(await buyOffers(session, 2, 3006103)).toEqual({ why: 'no-list' });
  const pole = { serial: 50, price: 15, description: 'fishing pole' };
  session.selectContext = () => {
    world.buyOffers.set(2, [pole]);
    world.received.set(0x74, (world.received.get(0x74) ?? 0) + 1);
  };
  expect(await buyOffers(session, 2, 3006103)).toEqual({ offers: [pole] });
});
