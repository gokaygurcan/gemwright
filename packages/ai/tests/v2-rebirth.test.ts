import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { Hands } from '../src/v2/hands';
import { rebirth } from '../src/v2/rebirth';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// A ghost standing right beside a healer: a healer only offers to a ghost that steps into its reach
// from farther off (ServUO BaseHealer.OnMovement, two tiles), so it steps out and back in, and takes
// the resurrection it is offered.
test('a ghost steps into a healer reach from outside it and takes the resurrection', async () => {
  const healer = { serial: 50, kind: 'mobile', graphic: 400, position: { x: 11, y: 10, z: 0 } };
  const gumps = new Map<string, { serial: number; id: number; layout: string }>();
  const world = {
    serial: 1,
    map: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    entities: new Map([[50, healer]]),
    gumps
  };
  const walks: string[] = [];
  const replies: number[] = [];
  const hands = {
    do: async (step: { verb: string; x: number; y: number; range: number }) => {
      const before = world.position;
      const to = { x: step.x + (step.range ? Math.sign(before.x - step.x) * step.range : 0), y: step.y, z: 0 };
      walks.push(`${to.x},${to.y}`);
      world.position = { ...to, direction: 0 };
      if (away(before, healer.position) > 2 && away(to, healer.position) <= 2)
        gumps.set('9:1', { serial: 9, id: 1, layout: '{ xmfhtmlgump 1011022 }' });
      return true;
    }
  } as unknown as Hands;
  const session = {
    world,
    replyGump: (serial: number) => {
      replies.push(serial);
      gumps.clear();
    }
  } as unknown as PlayerSession;
  await rebirth(
    session,
    hands,
    [{ kind: 'healer', x: 11, y: 10 }],
    (serial) => (serial === 50 ? 'Healer' : undefined),
    new Map(),
    () => false
  );
  expect(walks).toEqual(['7,10', '10,10']);
  expect(replies).toEqual([9]);
});

// No healer or ankh is ever ruled out: one that gave nothing is tried again after the others, in turn.
test('a ghost goes round every healer and ankh in turn and never stops trying', async () => {
  const world = {
    serial: 1,
    map: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    entities: new Map(),
    gumps: new Map()
  };
  const went: string[] = [];
  const hands = {
    do: async (step: { verb: string; x: number; y: number }) => {
      if (step.verb === 'walk') went.push(`${step.x},${step.y}`);
      return true;
    }
  } as unknown as Hands;
  const session = { world, use: () => {}, replyGump: () => {} } as unknown as PlayerSession;
  const shrines = [
    { kind: 'ankh' as const, x: 20, y: 10 },
    { kind: 'ankh' as const, x: 40, y: 10 }
  ];
  const tried = new Map<string, number>();
  const ankhs = () => went.filter((spot) => spot === '20,10' || spot === '40,10');
  for (let round = 0; round < 3; round++)
    await rebirth(
      session,
      hands,
      shrines,
      () => undefined,
      tried,
      () => false
    );
  expect([...new Set(ankhs())]).toEqual(['20,10', '40,10']);
  expect(ankhs().at(-1)).toBe('20,10');
}, 60_000);
