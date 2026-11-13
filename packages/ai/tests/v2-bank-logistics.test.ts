import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { empty } from '../src/v2/beliefs';
import { Hands } from '../src/v2/hands';
import { Mind } from '../src/v2/mind';
import { options } from '../src/v2/options';
import { advance, choices } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

function resident(name = 'IronIngot', amount = 3000, weight = 600) {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining', 'Blacksmith']);
  let at = 0;
  const observe = (kind: string, data: object) =>
    mind.observe({ resident: 'r', at: at++, kind, data, where: { x: 10, y: 10, z: 0, map: 1 } });
  observe('awake', {
    serial: 1,
    self: { health: { current: 100, max: 100 } },
    skills: { Mining: 100, Blacksmith: 50 }
  });
  observe('self', { weight: { current: 100, max: 150 } });
  observe('revealed', { serial: 2, parent: 1, layer: 21, is: ['Backpack'] });
  observe('revealed', { serial: 5, parent: 1, layer: 29, is: ['BankBox'] });
  observe('revealed', { serial: 10, parent: 5, amount, graphic: name.endsWith('Ore') ? 0x19b8 : 0x1bf2, is: [name] });
  observe('changed', { serial: 10, properties: [{ cliloc: 1072789, arguments: String(weight) }] });
  const entities = new Map<
    number,
    {
      serial: number;
      kind: string;
      graphic: number;
      parent: number;
      layer?: number;
      amount?: number;
      properties?: { cliloc: number; arguments: string }[];
    }
  >([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [5, { serial: 5, kind: 'item', graphic: 3701, parent: 1, layer: 29 }],
    [
      10,
      {
        serial: 10,
        kind: 'item',
        graphic: name.endsWith('Ore') ? 0x19b8 : 0x1bf2,
        parent: 5,
        amount,
        properties: [{ cliloc: 1072789, arguments: String(weight) }]
      }
    ]
  ]);
  const world = {
    serial: 1,
    map: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    status: { weight: 100, maxWeight: 150 },
    entities,
    journal: []
  };
  const moves: { serial: number; container: number; amount: number | undefined }[] = [];
  const session = {
    world,
    phase: 'ready',
    moveItem: async (serial: number, container: number, amount?: number) => {
      moves.push({ serial, container, amount });
      observe('acted', { verb: 'pick-up', serial, amount });
      Object.assign(entities.get(serial) ?? {}, { parent: container });
      observe('changed', { serial, parent: container });
    }
  } as unknown as PlayerSession;
  const places = {
    bankers: [{ x: 10, y: 10 }],
    vendors: [{ x: 12, y: 10, types: ['Blacksmith'] }],
    forges: [{ x: 11, y: 10, z: 0, id: 4017 }]
  };
  return { mind, observe, world, session, moves, places };
}

test('bank sales withdraw only the amount that fits before any sale frees weight', async () => {
  const r = resident();
  const sale = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors).find((o) =>
    o.key.startsWith('sell ')
  );
  const step = sale?.steps.find((s) => s.verb === 'withdraw');
  expect(step).toBeDefined();
  if (!step) throw new Error('No withdrawal');
  await new Hands(r.session, undefined, () => undefined, undefined, undefined, undefined, undefined).do(
    step,
    () => true
  );
  expect(r.moves[0]?.amount).toBe(250);
  expect(sale?.foresight?.lost).toEqual({ IronIngot: 250 });
  expect(sale?.frees).toBe(0);
});

test('banked ore can be withdrawn in a carrying-sized batch and smelted', () => {
  const r = resident('IronOre', 3000, 12000);
  const found = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors, r.places.forges);
  const smelt = found.find((o) => o.id?.startsWith('smelt '));
  expect(smelt?.steps.map((s) => s.verb)).toEqual(['walk', 'say', 'withdraw', 'walk', 'use', 'target']);
  expect(smelt?.foresight?.lost?.IronOre).toBe(12);
});

test('a withdrawal reserved for a sale is not immediately offered for deposit again', async () => {
  const r = resident('IronIngot', 43, 8.6);
  const sale = choices(r.mind, undefined, new Set(), r.places).find((o) => o.key.startsWith('sell '));
  if (!sale) throw new Error('No sale');
  await new Hands(r.session, undefined).do({ verb: 'withdraw', items: [10] }, () => true);
  const active = advance(advance(advance(sale.source)));
  const reconsidered = choices(r.mind, undefined, new Set(), r.places, active);
  expect(reconsidered.some((o) => o.key === 'deposit' && o.consumes?.includes(10))).toBe(false);
  expect(r.mind.belongings().get(10)?.amount).toBe(43);
});

test('checking a bank balance is information gathering, not the reward of buying a tool', () => {
  const r = resident();
  const found = options(r.mind, undefined, new Set(), r.places.bankers, [{ x: 12, y: 10, types: ['Tinker'] }]);
  const balance = found.find((o) => o.key === 'check bank balance');
  expect(balance?.value).toBeLessThanOrEqual(r.mind.temper.curiosity);
  r.observe('heard', { cliloc: 1042759, arguments: '0' });
  expect(
    options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors).some(
      (o) => o.key === 'check bank balance'
    )
  ).toBe(false);
});

test('a learned recipe obtains missing materials from the bank', () => {
  const r = resident('IronIngot', 43, 8.6);
  r.world.entities.set(11, { serial: 11, kind: 'item', graphic: 5091, parent: 2, amount: 1 });
  r.observe('revealed', { serial: 11, kind: 'item', graphic: 5091, parent: 2, is: ['SmithHammer'] });
  r.observe('acted', { verb: 'double-click', serial: 11 });
  r.observe('gump', { key: '11:42', value: { serial: 11, id: 42, layout: '{ button 40 60 4005 4007 1 0 21 }' } });
  const appraise = r.mind.appraise.bind(r.mind);
  r.mind.appraise = (key, ...args) =>
    key.includes('gump-response')
      ? {
          n: 2,
          value: 50,
          seconds: 3,
          outcome: { ...empty(), seconds: 3, lost: { IronIngot: 5 }, gained: { StuddedChest: 1 } }
        }
      : appraise(key, ...args);
  const craft = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors).find((o) =>
    o.key.includes('gump-response')
  );
  expect(craft?.steps.map((s) => s.verb)).toEqual(['walk', 'say', 'withdraw', 'use', 'gump-response']);
  expect(craft?.consumes).toContain(10);
});

test('a miner keeps and arms a usable weapon instead of banking it as trade goods', async () => {
  const r = resident();
  r.world.entities.set(12, { serial: 12, kind: 'item', graphic: 3937, parent: 2, amount: 1, properties: [] });
  r.observe('revealed', { serial: 12, kind: 'item', graphic: 3937, parent: 2, is: ['Longsword'] });
  const { arming } = await import('../src/v2/options');
  const terrain = { tile: () => ({ layer: 1, flags: 0x00400000 }) } as unknown as import('../src/terrain').Terrain;
  expect(arming(r.mind, terrain)).toEqual([{ verb: 'equip', serial: 12, layer: 1 }]);
  expect(
    options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors).some(
      (o) => o.key === 'deposit' && o.consumes?.includes(12)
    )
  ).toBe(false);
});

test('an already overloaded resident returns excess at the bank before attempting travel', () => {
  const r = resident();
  r.observe('acted', { verb: 'pick-up', serial: 10, amount: 3000 });
  r.observe('changed', { serial: 10, parent: 2 });
  Object.assign(r.world.entities.get(10) ?? {}, { parent: 2 });
  r.world.status.weight = 700;
  r.observe('self', { weight: { current: 700, max: 150 } });
  const vendor = r.places.vendors[0];
  if (vendor) vendor.x = 100;
  const best = choices(r.mind, undefined, new Set(), r.places)[0];
  expect(best?.key).toBe('return excess to bank');
  expect(best?.steps.map((s) => s.verb)).toEqual(['deposit']);
  expect(best?.steps[0]).toMatchObject({ amounts: { 10: 2750 } });
});

test('known bank equipment remains available after reconnect instead of being sold as unused goods', () => {
  const r = resident('Longsword', 1, 7);
  const item = r.world.entities.get(10);
  if (item) item.graphic = 3937;
  r.observe('changed', { serial: 10, graphic: 3937 });
  const saved = r.mind.snapshot();
  r.mind.restore(saved);
  r.observe('awake', { serial: 1, self: {}, skills: { Wrestling: 75, Swords: 75 } });
  r.world.entities.delete(10);
  const terrain = {
    tile: () => ({ flags: 0x00400000, layer: 1 }),
    findTiles: () => [],
    bestTiles: () => []
  } as unknown as import('../src/terrain').Terrain;
  const plans = choices(r.mind, terrain, new Set(), { bankers: r.places.bankers, vendors: [] });
  const gear = plans.find((p) => p.id.startsWith('retrieve equipment'));
  expect(gear?.steps.map((s) => s.verb)).toEqual(['walk', 'say', 'withdraw', 'equip']);
});

test('bank ore can fund a missing tool through smelting and selling, not repeated bank visits', () => {
  const r = resident('IronOre', 3000, 12000);
  r.observe('heard', { cliloc: 1042759, arguments: '0' });
  r.places.vendors[0]?.types.push('Tinker');
  const plans = choices(r.mind, undefined, new Set(), r.places);
  expect(plans[0]?.steps.map((s) => s.verb)).toEqual(['walk', 'say', 'withdraw', 'walk', 'use', 'target']);
  expect(plans[0]?.rate).toBeGreaterThan(-1);
  expect(plans[0]?.funding?.gold).toBeGreaterThan(0);
});

test('newly smelted output is sold to fund the tool instead of being banked again', () => {
  const r = resident('IronOre', 3000, 12000);
  r.observe('heard', { cliloc: 1042759, arguments: '0' });
  r.places.vendors[0]?.types.push('Tinker');
  const plan = choices(r.mind, undefined, new Set(), r.places)[0];
  if (!plan) throw new Error('No production plan');
  r.observe('lost', { serial: 10 });
  r.world.entities.delete(10);
  r.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x1bf2, parent: 2, amount: 12 });
  r.observe('gained', { serial: 20, parent: 2, is: ['IronIngot'], amount: 12 });
  const plans = choices(r.mind, undefined, new Set(), r.places);
  expect(plans[0]?.key.startsWith('sell ')).toBe(true);
  expect(plans[0]?.funding?.shortfall).toBeGreaterThan(0);
});

test('unknown bank weights lead to inspecting the stored item instead of guessing a carrying amount', () => {
  const r = resident();
  r.mind.snapshot().things.described.delete(10);
  const found = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors);
  expect(found.find((p) => p.id === 'inspect stored 10')?.steps.map((s) => s.verb)).toEqual(['walk', 'say', 'inspect']);
});

test('a remembered banked death robe is scheduled for disposal ahead of ordinary profitable work', () => {
  const r = resident();
  r.observe('revealed', { serial: 20, parent: 5, graphic: 7939, is: ['DeathRobe'] });
  const best = choices(r.mind, undefined, new Set(), r.places)[0];
  expect(best?.key).toBe('discard death robe');
  expect(best?.steps.at(-1)).toEqual({ verb: 'drop', serial: 20 });
});

test('a 3000-piece coloured ore stack is withdrawn as a small carrying-sized batch', async () => {
  const r = resident('ValoriteOre', 3000, 36000);
  const smelt = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors, r.places.forges).find((p) =>
    p.id?.startsWith('smelt ')
  );
  const taking = smelt?.steps.find((s) => s.verb === 'withdraw');
  expect(taking).toMatchObject({ amounts: { 10: 4 } });
  if (!taking) throw new Error('No ore withdrawal');
  expect(await new Hands(r.session, undefined).do(taking, () => true)).toBe(true);
  expect(r.moves[0]?.amount).toBe(4);
});

test('selling a spare weapon excludes the useful weapon kept for the resident', () => {
  const r = resident();
  for (const serial of [12, 13]) {
    r.world.entities.set(serial, { serial, kind: 'item', graphic: 3937, parent: 2, amount: 1 });
    r.observe('revealed', { serial, kind: 'item', graphic: 3937, parent: 2, is: ['Longsword'] });
  }
  const sale = options(r.mind, undefined, new Set(), r.places.bankers, r.places.vendors).find((p) =>
    p.key.startsWith('sell ')
  );
  expect(sale?.consumes).not.toContain(12);
  expect(sale?.steps.at(-1)).toMatchObject({ except: [12] });
});

test('a proficient unarmed fighter does not switch to an untrained weapon just because it is carried', async () => {
  const r = resident();
  r.observe('skill', { skill: 'Wrestling', value: 75, before: 0 });
  r.world.entities.set(12, { serial: 12, kind: 'item', graphic: 3937, parent: 2, amount: 1 });
  r.observe('revealed', { serial: 12, graphic: 3937, parent: 2, is: ['Longsword'] });
  const { arming } = await import('../src/v2/options');
  const terrain = { tile: () => ({ flags: 0x00400000, layer: 1 }) } as unknown as import('../src/terrain').Terrain;
  expect(arming(r.mind, terrain)).toEqual([]);
  Object.assign(r.world.entities.get(12) ?? {}, { parent: 1, layer: 1 });
  r.observe('changed', { serial: 12, parent: 1, layer: 1 });
  const stowing = arming(r.mind, terrain);
  expect(stowing).toEqual([{ verb: 'stow', serial: 12 }]);
  if (!stowing[0]) throw new Error('No preparation for unarmed combat');
  expect(await new Hands(r.session, undefined).do(stowing[0], () => true)).toBe(true);
  expect(r.world.entities.get(12)?.parent).toBe(2);
});
