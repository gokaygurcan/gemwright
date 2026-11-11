import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import { Hands } from '../src/v2/hands';
import { rebirth } from '../src/v2/rebirth';

// A ghost with a healer placed three tiles east: it walks over, the healer offers, it accepts. A
// healer that offered nothing is left for another while it is tried in vain.
test('a ghost goes to the nearest healer and accepts the resurrection offered', async () => {
  const replies: string[] = [];
  const world = {
    serial: 1,
    position: { x: 10, y: 10, z: 0, direction: 2 },
    entities: new Map(),
    gumps: new Map<string, { serial: number; id: number; layout: string }>()
  };
  const session = {
    world,
    walk: async () => {
      world.position = { ...world.position, x: world.position.x + 1 };
      if (world.position.x >= 12)
        world.gumps.set('5:7', { serial: 5, id: 7, layout: '{ xmfhtmlgump 0 0 0 0 1011022 0 0 }' });
      return true;
    },
    replyGump: (serial: number, id: number, button: number) => {
      replies.push(`${serial}:${id}:${button}`);
      world.gumps.delete(`${serial}:${id}`);
    }
  } as unknown as PlayerSession;
  const tried = new Map<string, number>();
  const shrines = [
    { kind: 'healer' as const, x: 15, y: 10 },
    { kind: 'ankh' as const, x: 40, y: 10 }
  ];
  const terrain = {
    pathAsync: async (start: { x: number }, goal: { x: number }, range: number) =>
      Array.from({ length: goal.x - start.x - range }, (_, i) => ({ x: start.x + i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  await rebirth(
    session,
    new Hands(session, terrain),
    shrines,
    () => undefined,
    tried,
    () => false
  );
  expect(replies).toEqual(['5:7:1']);
  expect(tried.size).toBe(0);
}, 15000);
