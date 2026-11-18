import { expect, test } from 'bun:test';

import { Hands } from '../src/hands';
import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import { choices } from '../src/planning';
import { traitsOf } from '../src/traits';
import { itemInContainer, propertyList, removeEntity } from './fixtures/shard-packets';
import { trainingShard } from './fixtures/training-shard';

function client(trade: string) {
  const shard = trainingShard('Tinkering');
  const mind = new Mind('r', () => {}, { ...traitsOf([], () => 0.5).traits, curiosity: 0 }, [], [trade]);
  const stop = perceive(shard.session, 'r', (event) => mind.observe(event));
  const hands = new Hands(
    shard.session,
    undefined,
    () => mind.mount,
    (id) => mind.call(id)
  );
  hands.notice = (kind, data) => mind.notice(kind, data);
  const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Blacksmith'] }] };
  const execute = async () => {
    const plan = choices(mind, undefined, new Set(), places)[0];
    if (!plan) throw new Error('No bank cycle plan');
    for (const step of plan.steps)
      if (!(await hands.do(step, () => true))) throw new Error(`Refused ${plan.key}: ${JSON.stringify(step)}`);
    mind.complete(plan.id, true);
    return plan.key;
  };
  const item = (serial: number, graphic: number, parent: number) => {
    shard.items.set(serial, { serial, graphic, parent, amount: 1 });
    shard.world.apply(itemInContainer(serial, graphic, 1, parent));
    shard.world.apply(propertyList(serial, 1072789, '0.1'));
  };
  return { ...shard, mind, stop, execute, item };
}

test('a full bank clears saleable pieces, sells them, and accepts a later deposit without putting them back', async () => {
  const c = client('Tactics');
  for (let n = 0; n < 125; n++) c.item(5000 + n, 3934, 5);
  const plans: string[] = [];
  try {
    expect(c.mind.bankCapacity.count).toBe(125);
    for (let turn = 0; turn < 12; turn++) {
      plans.push(await c.execute());
      if (c.sales.length > 0 && plans.at(-1) === 'deposit') break;
    }
    expect(plans[0]).toBe('clear bank room');
    const sale = plans.findIndex((key) => key.startsWith('sell '));
    expect(sale).toBeGreaterThan(0);
    expect(plans.slice(sale + 1)).toContain('deposit');
    expect(c.mind.bankCapacity.count).toBeLessThan(125);
    const cleared = [...c.mind.care.cooldowns.keys()]
      .filter((key) => key.startsWith('cleared '))
      .map((key) => Number(key.slice(8)));
    expect(cleared.length).toBeGreaterThan(0);
    for (const serial of cleared) expect(c.items.has(serial)).toBe(false);
    expect([...c.items.values()].filter((i) => i.graphic === 3821).reduce((n, i) => n + i.amount, 0)).toBe(
      2000 + 2 * c.sales.length
    );
  } finally {
    c.stop();
  }
});

test('insurance stores a spare, then retrieves it after the carried tool is lost', async () => {
  const c = client('Mining');
  c.item(5000, 3718, 2);
  c.item(5001, 3718, 2);
  try {
    for (let turn = 0; turn < 4 && !c.mind.has().bank.some((i) => i.serial === 5000 || i.serial === 5001); turn++)
      await c.execute();
    const stored = [5000, 5001].find((id) => c.mind.banked(id));
    expect(stored).toBeDefined();
    const carried = stored === 5000 ? 5001 : 5000;
    c.items.delete(carried);
    c.world.apply(removeEntity(carried));
    const purchases = c.purchases.length;
    await c.execute();
    expect(c.mind.carrying(stored as number)).toBe(true);
    expect(c.purchases).toHaveLength(purchases);
  } finally {
    c.stop();
  }
});
