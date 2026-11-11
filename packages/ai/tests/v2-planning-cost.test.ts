import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { WorkIndex } from '../src/terrain-work';
import { Beliefs, empty } from '../src/v2/beliefs';
import { Mind } from '../src/v2/mind';
import { choices, continuation } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

test('a refused drop is remembered for the same item, amount and place, including replay', () => {
  const events: Parameters<Mind['observe']>[0][] = [];
  const mind = new Mind('r', (e) => events.push(e), traitsOf([], () => 0.5).traits);
  const observe = (kind: string, data: object, x = 10) => {
    const event = { resident: 'r', at: 0, kind, data, where: { x, y: 10, z: 0, map: 1 } };
    events.push(event);
    mind.observe(event);
  };
  observe('awake', { serial: 1, self: {} });
  observe('revealed', { serial: 2, kind: 'item', parent: 1, layer: 21, is: ['Backpack'] });
  observe('revealed', { serial: 10, kind: 'item', parent: 2, amount: 3, is: ['Gold'] });
  mind.refuseDrop(10);
  expect(mind.canDrop(10)).toBe(false);
  const replay = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  for (const e of events) replay.observe(e);
  expect(replay.canDrop(10)).toBe(false);
  observe('acted', { verb: 'walk' }, 11);
  expect(mind.canDrop(10)).toBe(true);
  observe('changed', { serial: 10, amount: 4 });
  expect(mind.canDrop(10)).toBe(true);
});

test('unweighted expectations reuse accumulated outcomes instead of reading old outcomes', () => {
  const beliefs = new Beliefs();
  const outcome = { ...empty(), killed: 1 };
  beliefs.learn('attack', {}, outcome, (o) => o.killed);
  Object.defineProperty(outcome, 'killed', {
    get: () => {
      throw new Error('past rescanned');
    }
  });
  expect(beliefs.expect('attack', {}).outcome?.killed).toBe(1);
  expect(beliefs.trains('attack')).toBeUndefined();
});

test('spatial branch bounds prune blocks before querying their upper bound', () => {
  const map = Buffer.alloc(512 * 196);
  for (let block = 0; block < 512; block++) map.writeUInt16LE(1, block * 196 + 4);
  const index = new WorkIndex(map, Buffer.alloc(0), Buffer.alloc(0));
  let bounds = 0;
  const found = index.best(
    { land: [1], statics: [] },
    { x: 0, y: 0, z: 0 },
    (p) => -Math.max(p.x, p.y),
    (_kind, distance) => {
      bounds++;
      return -distance;
    }
  );
  expect(found[0]).toMatchObject({ x: 0, y: 0 });
  expect(bounds).toBeLessThan(40);
});

test('unchanged evidence does not deliberate again on each movement node', () => {
  let revision = 0;
  let calls = 0;
  const going = continuation(
    () => revision,
    () => ++calls < 3
  );
  for (let tile = 0; tile < 200; tile++) expect(going()).toBe(true);
  expect(calls).toBe(1);
  revision++;
  expect(going()).toBe(true);
  expect(calls).toBe(2);
  revision++;
  expect(going()).toBe(false);
});

test('walking and stamina updates preserve deliberation, while injury invalidates it', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const observe = (kind: string, data: object) => mind.observe({ resident: 'r', at: 0, kind, data });
  observe('awake', { serial: 1, self: { health: { current: 100, max: 100 } } });
  const before = mind.revision;
  observe('acted', { verb: 'walk' });
  observe('movement', { key: 'walk', steps: 1, seconds: 0.4, stamina: 1 });
  observe('self', { health: { current: 100, max: 100 }, stamina: 99 });
  observe('changed', { serial: 20, x: 12, y: 15 });
  expect(mind.revision).toBe(before);
  observe('self', { health: { current: 90, max: 100 } });
  expect(mind.revision).toBeGreaterThan(before);
});

test('a checkpoint resumes with identical beliefs and learns the same subsequent events', () => {
  const make = () => new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const full = make();
  const events = [
    { kind: 'awake', data: { serial: 1, self: { health: { current: 100, max: 100 } }, skills: {} } },
    { kind: 'revealed', data: { serial: 2, kind: 'item', parent: 1, layer: 21, is: ['Backpack'] } },
    { kind: 'revealed', data: { serial: 10, kind: 'item', parent: 2, amount: 3, is: ['Gold'] } },
    { kind: 'executed', data: { id: 'attack 20', succeeded: false } },
    { kind: 'movement', data: { key: 'foot run', steps: 10, seconds: 2, stamina: 1 } }
  ];
  for (const e of events) full.observe({ resident: 'r', at: 0, ...e });
  const resumed = make();
  resumed.restore(structuredClone(full.snapshot()));
  const next = { resident: 'r', at: 1, kind: 'changed', data: { serial: 10, amount: 8 } };
  full.observe(next);
  resumed.observe(next);
  expect(resumed.snapshot()).toEqual(full.snapshot());
  expect(resumed.chance('attack 20')).toBe(0.5);
  expect(resumed.belongings().get(10)?.amount).toBe(8);
});

test('equivalent overweight journeys share their inventory feasibility calculation', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Macing']);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {} } });
  mind.journeys = function* () {
    for (let x = 100; x < 1100; x++)
      yield {
        key: 'attack Zombie',
        where: { x, y: 100, z: 0, map: 1 },
        walk: x,
        chance: 0.5,
        expected: { ...empty(), seconds: 10, gained: { Gold: 10 } }
      };
  };
  let inventories = 0;
  const belongings = mind.belongings.bind(mind);
  mind.belongings = () => {
    inventories++;
    return belongings();
  };
  const session = {
    world: {
      serial: 1,
      position: { x: 0, y: 0, z: 0 },
      status: { weight: 493, maxWeight: 471, stamina: 100 },
      entities: new Map()
    }
  };
  expect(choices(mind, session as PlayerSession, undefined, new Set(), { bankers: [], vendors: [] })).toEqual([]);
  expect(inventories).toBeLessThan(20);
});
