import { expect, test } from 'bun:test';

import { TileFlag } from '@gemwright/common/assets/tiledata';
import { variable } from '@gemwright/network/packets';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { Hands } from '../src/hands';
import { equipmentToKeep } from '../src/inventory';
import { Mind } from '../src/mind';
import { arming, options } from '../src/options';
import { perceive } from '../src/perceive';
import type { Terrain } from '../src/terrain';
import { traitsOf } from '../src/traits';
import { itemInContainer, loginConfirm, mobileIncoming, targetCursor } from './fixtures/shard-packets';

const LONGSWORD = 3937;
const HALBERD = 5182;
const HEATER_SHIELD = 7030;
const SMITH_HAMMER = 5091;
const HORSE_BODY = 200;
const twoHanded = new Set([HALBERD, HEATER_SHIELD]);
const terrain = {
  tile: (graphic: number) => ({ flags: TileFlag.Wearable, height: 0, layer: twoHanded.has(graphic) ? 2 : 1 }),
  findTiles: () => [],
  bestTiles: () => []
} as unknown as Terrain;

// A fighter with a longsword, a halberd, a shield and a smith's hammer in its pack, a horse beside it.
function resident(skills: Record<string, number>) {
  const world = new WorldView();
  world.apply(loginConfirm(1, 10, 10, 0, 2));
  world.apply(variable(0xbf, Buffer.from([0, 8, 1])));
  world.apply(mobileIncoming(1, 400, 10, 10, 0, 2, [{ serial: 2, graphic: 3701, layer: 21 }]));
  for (const [serial, graphic] of [
    [20, LONGSWORD],
    [21, HALBERD],
    [22, HEATER_SHIELD],
    [23, SMITH_HAMMER]
  ] as const)
    world.apply(itemInContainer(serial, graphic, 1, 2));
  world.apply(mobileIncoming(30, HORSE_BODY, 12, 10, 0, 2));
  const session = { world, phase: 'ready' } as unknown as PlayerSession;
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const stop = perceive(session, 'r', (e) => mind.observe(e));
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: 1, kind, data });
  event('self', { attributes: { strength: 100, dexterity: 100, intelligence: 25 } });
  for (const [skill, value] of Object.entries(skills))
    event('skill', { skill, value, before: 0, base: value, cap: 100, lock: 0 });
  stop();
  return { world, session, mind };
}

test('with parrying it fights one-handed behind a shield; without, it doubles down on a two-handed weapon', () => {
  const parrier = resident({ Swords: 70, Parry: 80 });
  expect([...equipmentToKeep(parrier.mind, terrain)].sort()).toEqual([20, 22]);
  expect(arming(parrier.mind, terrain)).toEqual([
    { verb: 'equip', serial: 22, layer: 2 },
    { verb: 'equip', serial: 20, layer: 1 }
  ]);
  const brute = resident({ Swords: 70 });
  expect([...equipmentToKeep(brute.mind, terrain)]).toEqual([21]);
  expect(arming(brute.mind, terrain)).toEqual([{ verb: 'equip', serial: 21, layer: 2 }]);
});

test('a mount it can tame in view is worth taming instead of buying, and only then', () => {
  const tamer = resident({ AnimalTaming: 40 });
  const tame = options(tamer.mind, terrain, new Set()).find((o) => o.key === 'tame Horse');
  expect(tame?.steps).toEqual([
    { verb: 'walk', x: 12, y: 10, range: 2 },
    { verb: 'tame', serial: 30 },
    { verb: 'use', serial: 30 }
  ]);
  // A trainer's 550 gold at (40 - 29.1 + 0.1) / 50 odds, over the 12 seconds a try takes.
  expect(tame?.value).toBeCloseTo((550 * 11) / 50 - 12);
  const novice = resident({ AnimalTaming: 20 });
  expect(options(novice.mind, terrain, new Set()).some((o) => o.key.startsWith('tame '))).toBe(false);
});

test('taming ends with the shard saying it accepts it as master, or with its refusal', async () => {
  for (const [cliloc, tamed] of [
    [502799, true],
    [502798, false]
  ] as const) {
    const { world, session, mind } = resident({ AnimalTaming: 40 });
    const said = Buffer.alloc(47);
    said.writeUInt32BE(0xffffffff, 0);
    said.writeUInt32BE(cliloc, 11);
    Object.assign(session, {
      useSkill: () => world.apply(targetCursor(1)),
      target: () => world.apply(variable(0xc1, said))
    });
    const hands = new Hands(
      session,
      undefined,
      () => undefined,
      (id) => mind.call(id)
    );
    expect(await hands.do({ verb: 'tame', serial: 30 }, () => true)).toBe(tamed);
  }
});

test('a craft tool is tried only by one with some skill in its craft', () => {
  const probes = (skills: Record<string, number>) => {
    const { mind } = resident(skills);
    return options(mind, terrain, new Set()).filter((o) => o.id === 'probe 23').length;
  };
  expect(probes({ Swords: 50 })).toBe(0);
  expect(probes({ Blacksmith: 30 })).toBe(1);
});
