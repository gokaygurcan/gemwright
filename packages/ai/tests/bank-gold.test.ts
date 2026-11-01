import { expect, test } from 'bun:test';

import { Layer } from '@gemwright/network/layers';

import { bankNearbyGold, bankSurplus, chargedPurchase, knownBankGold, spendableGold } from '../src/bank-gold';
import { lasting } from '../src/lasting';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

let serial = 80000;
function bankingFixture(amount = 35) {
  const f = socialFixture('archer-tamer');
  const id = serial++;
  required(f.world.entities.get(11)).amount = amount;
  f.world.entities.set(20, {
    serial: 20,
    kind: 'mobile',
    graphic: 400,
    notoriety: 7,
    position: { ...required(f.world.position), x: 110 }
  });
  f.session.context = async () => [{ cliloc: 3006105, flags: 0, index: 0 }];
  let balance = 1000;
  f.session.say = (text) => {
    if (text === 'bank') {
      f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xe7c, parent: id, layer: Layer.Bank });
      f.world.received.set(0x3c, (f.world.received.get(0x3c) ?? 0) + 1);
    }
    if (text === 'balance')
      f.world.addJournal({ serial: 20, name: 'Banker', cliloc: 1042759, arguments: String(balance) });
  };
  f.session.moveItem = async (item, box, quantity) => {
    const coins = required(f.world.entities.get(item));
    expect(quantity).toBe(coins.amount);
    balance += coins.amount ?? 1;
    f.world.entities.set(item, { ...coins, parent: box });
  };
  const ctx = { ...f.ctx, serial: id, backpack: () => 10 };
  return { ...f, ctx };
}

test('a nearby banker takes every gold stack even below the banking threshold', async () => {
  const f = bankingFixture();
  f.world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xeed, parent: 10, amount: 7 });
  lasting('bank-ban', 1).set('surplus', Date.now() + 100000);
  expect(await bankNearbyGold(f.ctx)).toBe(true);
  expect(f.world.childrenOf(10).filter((i) => i.graphic === 0xeed)).toEqual([]);
  expect(f.checkpoint.personal?.economy?.bankedGold).toBe(42);
  expect(spendableGold(f.session, 10, f.checkpoint)).toBe(1042);
  await chargedPurchase(f.ctx, 50, async () => {});
  expect(f.checkpoint.funds?.bank).toBe(992);
  expect(await bankNearbyGold(f.ctx)).toBe(false);
});

test('nearby banking does not travel to a distant banker', async () => {
  const f = bankingFixture();
  required(f.world.entities.get(20)).position = { ...required(f.world.position), x: 120 };
  f.ctx.navigate = async () => {
    throw new Error('Should not travel');
  };
  expect(await bankNearbyGold(f.ctx)).toBe(false);
  expect(required(f.world.entities.get(11)).parent).toBe(10);
});

test('a refused deposit is not counted and is not retried every turn', async () => {
  const f = bankingFixture();
  let attempts = 0;
  f.session.moveItem = async () => {
    attempts++;
    throw new Error('Bank full');
  };
  expect(await bankNearbyGold(f.ctx)).toBe(false);
  expect(await bankNearbyGold(f.ctx)).toBe(false);
  expect(attempts).toBe(1);
  expect(f.checkpoint.personal?.economy?.bankedGold ?? 0).toBe(0);
});

test('a regular bank trip also deposits all gold without a shopping purse', async () => {
  const f = bankingFixture(800);
  lasting('bank-ban', 1).set('surplus', 0);
  f.ctx.navigate = async (point) => {
    f.world.position = { ...required(f.world.position), ...point };
    required(f.world.entities.get(20)).position = { ...required(f.world.position) };
  };
  expect(await bankSurplus(f.ctx, 'Britain')).toBe(true);
  expect(required(f.world.entities.get(11)).parent).toBe(30);
  expect(f.checkpoint.funds?.bank).toBe(1800);
});

test('AI purchase accounting translates network refusal into a recoverable funds blocker', async () => {
  const { CommandRejected } = await import('@gemwright/network');
  const { Blocked } = await import('../src/blocked');
  const f = bankingFixture();
  const bankBefore = f.checkpoint.funds?.bank;
  let error: unknown;
  try {
    await chargedPurchase(f.ctx, 50, async () => {
      throw new CommandRejected('vendor-insufficient-funds', 'Vendor refused');
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Blocked);
  expect((error as InstanceType<typeof Blocked>).reason).toBe('insufficient-funds');
  expect(f.checkpoint.funds?.bank).toBe(bankBefore);
});

test('a tool purchase with the bank balance unknown asks the banker first instead of counting only carried gold', async () => {
  const f = bankingFixture(0);
  delete f.checkpoint.funds;
  f.ctx.navigate = async () => {};
  const { buyTool } = await import('../src/vendor-trade');
  await buyTool(
    { ...f.ctx, city: 'Britain', carried: () => [], status: () => required(f.world.status) },
    'fisherman',
    [0xdc0]
  );
  expect(knownBankGold(f.checkpoint)).toBe(1000);
});

test('a bank deposit reports what the shard refused, with its reason, and still moves the rest', async () => {
  const f = bankingFixture(35);
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x1bdd, parent: 10, amount: 50 });
  f.world.entities.set(41, { serial: 41, kind: 'item', graphic: 0x1bd7, parent: 10, amount: 20 });
  f.session.moveItem = async (item, box) => {
    if (item === 40) throw new Error('Server rejected item lift');
    f.world.entities.set(item, { ...required(f.world.entities.get(item)), parent: box });
  };
  const { deposit } = await import('../src/bank-box');
  const result = await deposit(f.ctx, { banker: 20, box: 30 }, [
    required(f.world.entities.get(40)),
    required(f.world.entities.get(41))
  ]);
  expect(result.moved).toEqual([41]);
  expect(result.refused).toEqual([{ serial: 40, reason: 'Server rejected item lift' }]);
});
