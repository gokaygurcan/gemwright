import { expect, test } from 'bun:test';

import { hueOf } from '@gemwright/common/game/rules';
import { CommandRejected } from '@gemwright/network/errors';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import { dress } from '../src/v2/dress';

// Raised by a healer in the shard's death robe, with its own robe in its pack: its robe goes back on
// and the death robe is dropped.
test('its own robe goes back on over a death robe, which it drops', async () => {
  const done: string[] = [];
  const entities = new Map<
    number,
    { serial: number; kind: string; graphic: number; hue?: number; parent?: number; layer?: number }
  >([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [3, { serial: 3, kind: 'item', graphic: 7939, hue: hueOf('DeathRobe'), parent: 1, layer: 22 }],
    [4, { serial: 4, kind: 'item', graphic: 7939, hue: 1105, parent: 2 }]
  ]);
  const session = {
    world: { serial: 1, entities },
    moveItem: async (serial: number, container: number) => {
      done.push(`move ${serial} to ${container}`);
      Object.assign(entities.get(serial) ?? {}, { parent: container, layer: undefined });
    },
    equipItem: async (serial: number, layer: number) => {
      done.push(`wear ${serial}`);
      Object.assign(entities.get(serial) ?? {}, { parent: 1, layer });
    },
    resyncPosition: async () => true,
    dropAtFeet: async (serial: number) => {
      done.push(`drop ${serial}`);
      entities.delete(serial);
    }
  } as unknown as PlayerSession;
  const terrain = { tile: () => ({ flags: 0x00400000, layer: 22 }) } as unknown as Terrain;
  expect(await dress(session, terrain, () => 0, new Map())).toBe(true);
  expect(done).toEqual(['move 3 to 2', 'wear 4', 'drop 3']);
});

// Dropped once, the death robe is gone: nothing more to drop.
test('a dropped death robe is dropped once', async () => {
  const drops: number[] = [];
  const entities = new Map([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [3, { serial: 3, kind: 'item', graphic: 7939, hue: hueOf('DeathRobe'), parent: 2 }]
  ]);
  const session = {
    world: { serial: 1, entities },
    resyncPosition: async () => true,
    dropAtFeet: async (serial: number) => {
      drops.push(serial);
      entities.delete(serial);
    }
  } as unknown as PlayerSession;
  const terrain = { tile: () => ({ flags: 0, layer: 0 }) } as unknown as Terrain;
  const refused = new Map<number, string>();
  expect(await dress(session, terrain, () => 0, refused)).toBe(true);
  expect(await dress(session, terrain, () => 0, refused)).toBe(false);
  expect(drops).toEqual([3]);
});

// Before dropping the death robe it asks the shard where it stands, so the drop lands on its own tile
// at the height the shard has; if the shard still refuses, the robe stays in its pack.
test('the death robe is dropped where the shard says it stands, and a refusal is no crash', async () => {
  const done: string[] = [];
  const entities = new Map([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [3, { serial: 3, kind: 'item', graphic: 7939, hue: hueOf('DeathRobe'), parent: 2 }]
  ]);
  const session = {
    world: { serial: 1, entities },
    resyncPosition: async () => done.push('where am I'),
    dropAtFeet: async () => {
      done.push('drop');
      throw new CommandRejected('item-drop-rejected', 'Ground drop refused; item returned to its owner');
    }
  } as unknown as PlayerSession;
  const terrain = { tile: () => ({ flags: 0, layer: 0 }) } as unknown as Terrain;
  expect(await dress(session, terrain, () => 0, new Map())).toBe(true);
  expect(done).toEqual(['where am I', 'drop']);
});

// Refused here, it carries on; standing somewhere else later, it tries again.
test('a refused robe drop is tried again from another tile', async () => {
  const drops: string[] = [];
  const world = {
    serial: 1,
    position: { x: 5, y: 5, z: 0, direction: 0 },
    entities: new Map([
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      [3, { serial: 3, kind: 'item', graphic: 7939, hue: hueOf('DeathRobe'), parent: 2 }]
    ])
  };
  const session = {
    world,
    resyncPosition: async () => true,
    dropAtFeet: async () => {
      drops.push(`${world.position.x},${world.position.y}`);
      throw new CommandRejected('item-drop-rejected', 'Ground drop refused; item returned to its owner');
    }
  } as unknown as PlayerSession;
  const terrain = { tile: () => ({ flags: 0, layer: 0 }) } as unknown as Terrain;
  const refused = new Map<number, string>();
  await dress(session, terrain, () => 0, refused);
  await dress(session, terrain, () => 0, refused);
  world.position = { ...world.position, x: 9 };
  await dress(session, terrain, () => 0, refused);
  expect(drops).toEqual(['5,5', '9,5']);
});
