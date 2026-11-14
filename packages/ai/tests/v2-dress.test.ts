import { expect, test } from 'bun:test';

import { hueOf } from '@gemwright/common/game/rules';
import { CommandRejected } from '@gemwright/network/errors';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import { dress, shed } from '../src/v2/dress';
import { heard } from './fixtures/journal';
import { mindFor, perceived } from './fixtures/v2/mind-sync';

const ROBE = 7939;
const deathRobe = hueOf('DeathRobe');
// A screen whose drops land on the floor, or are refused (the robe back in the pack, as the shard
// answers a refused lift: "You must wait to perform another action", 500119) while `refuse` says so.
function shard(
  things: [number, { serial: number; kind: string; graphic: number; hue?: number; parent?: number; layer?: number }][],
  refuse: () => boolean = () => false
) {
  const done: string[] = [];
  const entities = new Map(things);
  const journal: { cliloc?: number }[] = [];
  const world = heard({ serial: 1, position: { x: 5, y: 5, z: 0 }, entities, journal });
  const session = {
    world,
    // The shard's answer to 0x22: where it truly stands, a floor up from what the client believed.
    resyncPosition: async () => {
      done.push('where am I');
      world.position = { x: 5, y: 5, z: 20 };
      return true;
    },
    moveItem: async (serial: number, container: number) => {
      done.push(`move ${serial} to ${container}`);
      Object.assign(entities.get(serial) ?? {}, { parent: container, layer: undefined });
    },
    equipItem: async (serial: number, layer: number) => {
      done.push(`wear ${serial}`);
      Object.assign(entities.get(serial) ?? {}, { parent: 1, layer });
    },
    dropAtFeet: async (serial: number) => {
      if (refuse()) {
        done.push(`refused ${serial}`);
        journal.push({ cliloc: 500119 });
        Object.assign(entities.get(serial) ?? {}, { parent: 2, layer: undefined });
        throw new CommandRejected('item-drop-rejected', 'Ground drop refused; item returned to its owner');
      }
      done.push(`drop ${serial} at ${world.position.x},${world.position.y},${world.position.z}`);
      entities.delete(serial);
    }
  };
  const mind = mindFor(session);
  return { done, entities, mind, session: perceived(session, mind) };
}

// Raised in the shard's death robe with its own robe in its pack: the death robe goes to the floor
// first, then its own robe goes on.
test('a worn death robe is on the floor before its own robe goes back on', async () => {
  const { done, mind, session } = shard([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [3, { serial: 3, kind: 'item', graphic: ROBE, hue: deathRobe, parent: 1, layer: 22 }],
    [4, { serial: 4, kind: 'item', graphic: ROBE, hue: 1105, parent: 2 }]
  ]);
  const terrain = { tile: () => ({ flags: 0x00400000, layer: 22 }) } as unknown as Terrain;
  expect(
    await shed(
      session,
      mind,
      () => false,
      () => {},
      () => {}
    )
  ).toBe(true);
  expect(await dress(session, mind, terrain)).toBe(true);
  expect(done).toEqual(['where am I', 'drop 3 at 5,5,20', 'wear 4']);
});

// Every death robe it carries, in its pack and in bags in it, goes to the floor; once down, there is
// nothing more to drop.
test('every carried death robe is put on the floor, and only once', async () => {
  const { done, mind, session } = shard([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [6, { serial: 6, kind: 'item', graphic: 3701, parent: 2 }],
    [10, { serial: 10, kind: 'item', graphic: ROBE, hue: deathRobe, parent: 2 }],
    [11, { serial: 11, kind: 'item', graphic: ROBE, hue: deathRobe, parent: 2 }],
    [12, { serial: 12, kind: 'item', graphic: ROBE, hue: deathRobe, parent: 6 }]
  ]);
  expect(
    await shed(
      session,
      mind,
      () => false,
      () => {},
      () => {}
    )
  ).toBe(true);
  expect(
    await shed(
      session,
      mind,
      () => false,
      () => {},
      () => {}
    )
  ).toBe(true);
  expect(done.filter((step) => step.startsWith('drop')).sort()).toEqual([
    'drop 10 at 5,5,20',
    'drop 11 at 5,5,20',
    'drop 12 at 5,5,20'
  ]);
});

// The shard refusing a drop (too soon after the last action) does not move it on: the same robe is
// tried again, on the same tile at the height the shard says it stands, at the shard's pace, until it
// lies on the floor.
test('a refused robe drop is tried again on the same tile until the robe is on the floor', async () => {
  let refusals = 2;
  const { done, mind, session } = shard(
    [
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      [3, { serial: 3, kind: 'item', graphic: ROBE, hue: deathRobe, parent: 2 }]
    ],
    () => refusals-- > 0
  );
  expect(
    await shed(
      session,
      mind,
      () => false,
      () => {},
      () => {}
    )
  ).toBe(true);
  expect(done).toEqual(['where am I', 'refused 3', 'where am I', 'refused 3', 'where am I', 'drop 3 at 5,5,20']);
});

test('a thrown equipment refusal is remembered so the next turn can do different work', async () => {
  let attempts = 0;
  const session = {
    world: {
      serial: 1,
      entities: new Map([
        [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
        [4, { serial: 4, kind: 'item', graphic: 0x311, parent: 2 }]
      ])
    },
    equipItem: async () => {
      attempts++;
      throw new CommandRejected('equipment-rejected', 'Equipment refused');
    }
  } as unknown as PlayerSession;
  const terrain = { tile: () => ({ flags: 0x00400000, layer: 7 }) } as unknown as Terrain;
  for (let turn = 0; turn < 4; turn++) {
    try {
      await dress(perceived(session, mindFor(session)), mindFor(session), terrain);
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRejected);
    }
  }
  expect(attempts).toBe(1);
});

test('usable armor inside an owned bag is worn rather than overlooked', async () => {
  const entities = new Map([
    [2, { serial: 2, graphic: 3701, parent: 1, layer: 21 }],
    [6, { serial: 6, graphic: 3701, parent: 2 }],
    [10, { serial: 10, graphic: 5083, parent: 6 }]
  ]);
  const worn: number[] = [];
  const session = {
    world: { serial: 1, entities },
    equipItem: async (serial: number, layer: number) => {
      worn.push(serial);
      Object.assign(entities.get(serial) ?? {}, { parent: 1, layer });
    }
  } as unknown as PlayerSession;
  const terrain = {
    tile: (graphic: number) => ({ flags: graphic === 5083 ? 0x00400000 : 0, layer: 13 })
  } as unknown as Terrain;
  expect(await dress(perceived(session, mindFor(session)), mindFor(session), terrain)).toBe(true);
  expect(worn).toEqual([10]);
});

test('a weapon the shard refused to put in its hands is never offered for arming again', async () => {
  const { Hands } = await import('../src/v2/hands');
  const { arming } = await import('../src/v2/options');
  const entities = new Map([
    [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
    [9, { serial: 9, kind: 'item', graphic: 0x901, parent: 2 }]
  ]);
  const session = {
    world: { serial: 1, entities },
    moveItem: async () => {},
    equipItem: async () => {
      throw new CommandRejected('equipment-rejected', 'Equipment refused (0x901 on layer 1)');
    }
  } as unknown as PlayerSession;
  const mind = mindFor(session);
  perceived(session, mind);
  const hands = new Hands(session, undefined);
  hands.notice = (kind, data) => mind.notice(kind, data);
  await expect(hands.do({ verb: 'equip', serial: 9, layer: 1 }, () => true)).rejects.toBeInstanceOf(CommandRejected);
  expect(mind.wears(9)).toBe(false);
  const terrain = { tile: () => ({ flags: 0x00400000, layer: 1 }) } as unknown as Terrain;
  expect(arming(mind, terrain).some((step) => 'serial' in step && step.serial === 9)).toBe(false);
});
