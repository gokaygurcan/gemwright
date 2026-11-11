import { expect, test } from 'bun:test';

import { moongate } from '@gemwright/common/game/items';
import { moongateList } from '@gemwright/common/game/rules';
import { offersReply } from '@gemwright/network/gumps';
import type { PlayerSession } from '@gemwright/network/session';

import { Hands } from '../src/v2/hands';
import { Reach } from '../src/v2/reach';
import type { WalkGraph } from '../src/walk-graph';
import type { Ground } from '../src/walk-graph-build';

function trip(ghost = false) {
  const from = { x: 10, y: 10, z: 31 };
  const target = moongateList.moonglow;
  const sent: unknown[] = [];
  const world = {
    serial: 1,
    map: 1,
    position: { ...from, direction: 2 },
    entities: new Map([
      [1, { serial: 1, graphic: ghost ? 402 : 400 }],
      [2, { serial: 2, graphic: moongate, position: from }]
    ]),
    gumps: new Map<number, { serial: number; id: number; layout: string }>(),
    journal: [] as { cliloc: number }[]
  };
  const layout = `{ button 0 0 0 0 1 0 1 } { xmfhtmlgump 0 0 0 0 1012011 } { page 1 } { xmfhtmlgump 0 1 0 0 1012012 } { radio 0 20 0 0 0 42 } { xmfhtmlgump 0 20 0 0 ${target.label} }`;
  const offer = () => world.gumps.set(7, { serial: 2, id: 7, layout });
  const session = {
    world,
    use: (serial: number) => {
      sent.push(['use', serial]);
      offer();
    },
    replyGump: (...args: unknown[]) => {
      expect(offersReply(layout, args[2] as number, args[3] as number[], [])).toBe(true);
      sent.push(args);
      world.position = { ...target, x: target.x + 2, direction: 2 };
    },
    walk: async (direction: number) => {
      if (world.position.direction !== direction) world.position.direction = direction;
      else world.position = { ...world.position, x: world.position.x + (direction === 2 ? 1 : -1) };
      if (world.position.x === from.x) offer();
      return true;
    }
  } as unknown as PlayerSession;
  const hands = new Hands(session, undefined);
  hands.reach = {
    route: () => ({
      steps: 10,
      legs: [
        { kind: 'gate', ...from, to: 'moonglow' },
        { kind: 'walk', ...target, x: target.x + 4 }
      ]
    })
  } as unknown as Reach;
  const go = (going = () => true) => hands.do({ verb: 'walk', x: target.x + 4, y: target.y, range: 0 }, going);
  return { world, session, hands, sent, go };
}

test('a gate route opens the menu, selects its Trammel destination and continues from arrival', async () => {
  const f = trip();
  expect(await f.go()).toBe(true);
  expect(f.sent).toEqual([
    ['use', 2],
    [2, 7, 1, [42]]
  ]);
  expect(f.world.position.x).toBe(moongateList.moonglow.x + 4);
});

test('a ghost steps off and onto the observed gate instead of double clicking', async () => {
  const f = trip(true);
  expect(await f.go()).toBe(true);
  expect(f.sent).toEqual([[2, 7, 1, [42]]]);
});

test('a missing observed gate fails without using anything', async () => {
  const f = trip();
  f.world.entities.delete(2);
  expect(await f.go()).toBe(false);
  expect(f.sent).toEqual([]);
});

test('a refused arrival does not continue walking at the source', async () => {
  const f = trip();
  Object.assign(f.session, { replyGump: () => f.world.journal.push({ cliloc: 1005561 }) });
  expect(await f.go()).toBe(false);
  expect(f.world.position.x).toBe(10);
});

test('waiting for a menu can be interrupted without replying', async () => {
  const f = trip();
  Object.assign(f.session, { use: () => {} });
  let checks = 0;
  expect(await f.go(() => ++checks < 5)).toBe(false);
  expect(f.sent).toEqual([]);
});

test('reach enables gates for both distance estimates and execution routes', () => {
  const graph = {
    from: (_: unknown, open?: (name: string) => boolean) => {
      expect(open?.('moonglow') ?? true).toBe(true);
      return () => 12;
    },
    route: (_: unknown, __: unknown, open?: (name: string) => boolean) => {
      expect(open?.('moonglow') ?? true).toBe(true);
      return { steps: 12, legs: [] };
    }
  } as unknown as WalkGraph;
  const terrain = { standingZ: () => 0 } as unknown as Ground;
  const reach = new Reach(graph, terrain);
  const from = { x: 10, y: 10, z: 0 };
  expect(reach.steps(from, moongateList.moonglow)).toBe(12);
  expect(reach.route(from, moongateList.moonglow, 1)?.steps).toBe(12);
});

test('an old destination menu is not answered for a new gate use', async () => {
  const f = trip();
  f.session.use(2);
  f.sent.length = 0;
  Object.assign(f.session, { use: () => {} });
  let checks = 0;
  expect(await f.go(() => ++checks < 5)).toBe(false);
  expect(f.sent).toEqual([]);
});

test('arrival at the right coordinates on another facet does not complete the gate leg', async () => {
  const f = trip();
  Object.assign(f.session, {
    replyGump: () => {
      f.world.position = { ...moongateList.moonglow, direction: 2 };
      f.world.map = 0;
    }
  });
  let checks = 0;
  expect(await f.go(() => ++checks < 6)).toBe(false);
  expect(f.world.position.x).toBe(moongateList.moonglow.x);
});

test('a menu without the intended Trammel destination is never answered', async () => {
  const f = trip();
  Object.assign(f.session, {
    use: () => f.world.gumps.set(7, { serial: 2, id: 7, layout: '{ button 0 0 0 0 1 0 1 }' })
  });
  let checks = 0;
  expect(await f.go(() => ++checks < 5)).toBe(false);
  expect(f.sent).toEqual([]);
});

test('it walks within one tile of the observed gate at its shard height', async () => {
  const f = trip();
  f.world.position = { x: 7, y: 10, z: 31, direction: 2 };
  expect(await f.go()).toBe(true);
  expect(f.sent[0]).toEqual(['use', 2]);
});

test('a gate that never transfers the player times out without walking the next leg', async () => {
  const f = trip();
  Object.assign(f.session, { replyGump: () => {} });
  expect(await f.go()).toBe(false);
  expect(f.world.position.x).toBe(10);
}, 10_000);

test('pricing bank-to-vendor plans reuses both route origins', () => {
  let searches = 0;
  const graph = {
    from: () => {
      searches++;
      return () => 10;
    }
  } as unknown as WalkGraph;
  const terrain = { standingZ: () => 0 } as unknown as Ground;
  const reach = new Reach(graph, terrain);
  const here = { x: 10, y: 10, z: 0 };
  const bank = { x: 100, y: 100, z: 0 };
  for (let i = 0; i < 3; i++) {
    reach.steps(here, bank);
    reach.steps(bank, moongateList.moonglow);
  }
  expect(searches).toBe(2);
});
