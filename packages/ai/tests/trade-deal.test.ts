import { expect, test } from 'bun:test';

import { gold } from '@gemwright/common/items';
import type { TradeWindow } from '@gemwright/network/trade';

import { buyByTrade, buyPetByTrade, lastFailure, sellByTrade, sellPetByTrade } from '../src/trade-deal';
import { workCounts } from '../src/work-evidence';
import { behaviorFixture, required } from './behavior-fixture';

const boards = 0x1bd7;
const match = (item: { graphic: number }) => item.graphic === boards;
function fixture(
  side: 'buy' | 'sell',
  options: {
    settle?: 'cancel' | 'changed' | 'replace' | 'late' | 'missing-goods' | 'missing-payment';
    pet?: boolean;
  } = {}
) {
  const f = behaviorFixture();
  let next = 100;
  const trade: TradeWindow = {
    partner: 2,
    mine: 20,
    theirs: 21,
    name: 'Player',
    closed: false,
    accepted: { me: false, them: false }
  };
  f.world.trade = trade;
  const put = (serial: number, graphic: number, amount: number, parent: number) =>
    f.world.entities.set(serial, { serial, kind: 'item', graphic, amount, parent });
  put(20, 0xe75, 1, 1);
  put(21, 0xe75, 1, 2);
  if (side === 'sell') {
    put(30, boards, 10, 10);
    put(31, gold, 50, 21);
  } else put(30, options.pet ? 0x14f0 : boards, 10, 21);
  f.world.status = { ...required(f.world.status), followers: options.pet && side === 'sell' ? 1 : 0, maxFollowers: 5 };
  const accepted: boolean[] = [];
  const waits: string[] = [];
  let canceled = 0;
  f.session.moveItem = async (serial, parent, amount) => {
    const old = required(f.world.entities.get(serial));
    const take = amount ?? old.amount ?? 1;
    old.amount = (old.amount ?? 1) - take;
    if (!old.amount) f.world.entities.delete(serial);
    put(next++, old.graphic, take, parent);
  };
  f.session.cancelTrade = () => {
    canceled++;
    trade.closed = true;
  };
  f.session.acceptTrade = (yes = true) => {
    accepted.push(yes);
    trade.accepted.me = yes;
  };
  f.session.refreshStatus = async () => {};
  f.session.context = async () => [{ cliloc: 3006113, index: 0, flags: 0 }];
  f.session.selectContext = () => {
    f.world.target = { id: 42, ground: false, flags: 0 };
  };
  const deliver = () => {
    if (side === 'sell') {
      if (options.pet && options.settle !== 'missing-goods') required(f.world.status).followers = 0;
      for (const item of f.world.childrenOf(20)) {
        if (options.settle === 'missing-goods') f.world.entities.set(item.serial, { ...item, parent: 10 });
        else f.world.entities.delete(item.serial);
      }
      if (options.settle !== 'missing-payment') required(f.world.entities.get(11)).amount = 1050;
    } else {
      if (options.settle !== 'missing-payment')
        for (const item of f.world.childrenOf(20)) f.world.entities.delete(item.serial);
      if (options.pet) {
        if (options.settle !== 'missing-goods') required(f.world.status).followers = 1;
      } else if (options.settle !== 'missing-goods') put(next++, boards, 10, 10);
    }
  };
  f.session.waitFor = async (predicate, label) => {
    waits.push(label);
    if (label === 'trade completion') {
      if (options.settle === 'changed') {
        required(f.world.entities.get(31)).amount = 1;
        trade.accepted.me = false;
      } else if (options.settle === 'replace') {
        f.world.trade = { ...trade, mine: 50, partner: 99 };
      } else {
        trade.closed = true;
        if (options.settle !== 'cancel' && options.settle !== 'late') deliver();
      }
    }
    if (options.settle === 'late' && /trade payment|trade goods|pet ownership/.test(label)) {
      await Bun.sleep(20);
      deliver();
    }
    if (!predicate()) throw new Error(`Unconfirmed ${label}`);
  };
  return { ...f, trade, accepted, waits, canceled: () => canceled };
}

test('seller accepts the agreed payment and verifies delivered gold plus outgoing goods', async () => {
  const f = fixture('sell', { settle: 'late' });
  expect(await sellByTrade(f.session, 10, 2, match, 10, 50)).toBe(true);
  expect(f.accepted).toEqual([true]);
  expect(f.waits).toContain('trade payment and outgoing goods');
  expect(workCounts(f.session).tradeGoldIn).toBe(50);
  expect(workCounts(f.session).trades).toBe(1);
});

test('buyer verifies both goods arriving and the full payment debit', async () => {
  const f = fixture('buy', { settle: 'late' });
  expect(await buyByTrade(f.session, 10, 2, match, 10, 50)).toBe(true);
  expect(f.accepted).toEqual([true]);
  expect(workCounts(f.session).tradeGoldOut).toBe(50);
});

test('a canceled window cannot become a completed sale or purchase', async () => {
  for (const side of ['sell', 'buy'] as const) {
    const f = fixture(side, { settle: 'cancel' });
    expect(await (side === 'sell' ? sellByTrade : buyByTrade)(f.session, 10, 2, match, 10, 50)).toBe(false);
    expect(workCounts(f.session).trades).toBeUndefined();
    expect(lastFailure(f.session)).toMatch(/arrive|swap/);
  }
});

test('a reduced offer or replaced trade window is never accepted again as the original deal', async () => {
  for (const settle of ['changed', 'replace'] as const) {
    const f = fixture('sell', { settle });
    expect(await sellByTrade(f.session, 10, 2, match, 10, 50)).toBe(false);
    expect(f.accepted).toEqual([true]);
    if (settle === 'replace') expect(f.canceled()).toBe(0);
    expect(workCounts(f.session).trades).toBeUndefined();
  }
});

test('post-close success needs both sides of the exchange, including free item transfers', async () => {
  for (const [side, missing] of [
    ['sell', 'missing-payment'],
    ['sell', 'missing-goods'],
    ['buy', 'missing-goods']
  ] as const) {
    const f = fixture(side, { settle: missing });
    expect(await (side === 'sell' ? sellByTrade : buyByTrade)(f.session, 10, 2, match, 10, 50)).toBe(false);
  }
  const free = fixture('buy');
  expect(await buyByTrade(free.session, 10, 2, match, 10, 0)).toBe(true);
});

test('pet purchases require observed follower ownership and payment; money loss alone is not completion', async () => {
  const missing = fixture('buy', { pet: true, settle: 'missing-goods' });
  expect(await buyPetByTrade(missing.session, 10, 2, 50)).toBe(false);
  expect(workCounts(missing.session).trades).toBeUndefined();
  const unknown = fixture('buy', { pet: true });
  required(unknown.world.status).followers = undefined;
  expect(await buyPetByTrade(unknown.session, 10, 2, 50)).toBe(false);
  expect(unknown.accepted).toEqual([]);
  const unsold = fixture('sell', { pet: true, settle: 'missing-goods' });
  expect(await sellPetByTrade(unsold.session, 10, 2, 42, 50)).toBe(false);
  const sold = fixture('sell', { pet: true });
  expect(await sellPetByTrade(sold.session, 10, 2, 42, 50)).toBe(true);
  const received = fixture('buy', { pet: true });
  expect(await buyPetByTrade(received.session, 10, 2, 50)).toBe(true);
});

test('invalid quantities and prices never dispatch acceptance', async () => {
  for (const [amount, price] of [
    [0, 1],
    [-1, 1],
    [1, -1],
    [1, Number.NaN]
  ]) {
    const f = fixture('buy');
    expect(await buyByTrade(f.session, 10, 2, match, amount ?? 0, price ?? 0)).toBe(false);
    expect(f.accepted).toEqual([]);
  }
});
