import { expect, test } from 'bun:test';

import type { Position } from '@gemwright/network/world';

import { areaOfPlace } from '../src/areas';
import { Blocked } from '../src/blocked';
import { type Dungeon, dungeonAt, dungeons, exitStair, floorAt } from '../src/dungeons';
import { destinationGate, travelJourney } from '../src/journey';
import { type Gate, moongates } from '../src/moongate';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function travelFixture(start: Position) {
  const f = socialFixture();
  f.world.position = start;
  const legs: { x: number; y: number; z?: number }[] = [];
  const crossings: Gate[] = [];
  const stairs: Position[] = [];
  const walk = async (point: { x: number; y: number; z?: number }) => {
    legs.push(point);
    f.world.position = { ...required(f.world.position), ...point };
    f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xf6c, position: { ...required(f.world.position) } });
  };
  f.session.use = () => {
    const layout =
      '{ xmfhtmlgump 0 0 0 0 1012011 } { page 1 } { xmfhtmlgump 0 1 0 0 1012012 } ' +
      Object.values(moongates)
        .map((gate, i) => `{ radio 0 ${i + 10} 0 0 0 ${i} } { xmfhtmlgump 0 ${i + 10} 0 0 ${gate.label} }`)
        .join(' ');
    f.world.gumps.set('gate', { serial: 20, id: 1, packed: false, layout });
  };
  f.session.replyGump = (_serial, _id, _button, switches) => {
    const gate = required((Object.keys(moongates) as Gate[])[required(switches[0])]);
    crossings.push(gate);
    f.world.position = { ...required(f.world.position), ...moongates[gate] };
    f.world.gumps.clear();
  };
  f.session.waitFor = async (predicate, label) => {
    if (label === 'stairway teleport' && stairs.length) f.world.position = required(stairs.shift());
    if (!predicate()) throw new Error(`Missing confirmation: ${label}`);
  };
  return { ...f, walk, legs, crossings, stairs };
}

for (const [from, to] of [
  ['jhelom', 'britain'],
  ['britain', 'jhelom'],
  ['moonglow', 'jhelom']
] as const)
  test(`travel from ${from} to ${to} takes its own gate before walking to the destination`, async () => {
    const f = travelFixture({ ...moongates[from], direction: 0 });
    await travelJourney(f.ctx, moongates[to], 1, f.walk);
    expect(f.legs[0]).toEqual(moongates[from]);
    expect(f.crossings).toEqual([to]);
    expect(f.legs.at(-1)).toEqual(moongates[to]);
  });

test('a destination gate must be on its connected land, regardless of straight-line distance', () => {
  const mainland = areaOfPlace(moongates.britain);
  expect(destinationGate({ x: 650, y: 2070 }, mainland)).toBe('britain');
  expect(destinationGate({ x: 650, y: 2070 }, areaOfPlace(moongates.skara))).toBe('skara');
  expect(destinationGate({ x: 650, y: 2070 }, -1)).toBeUndefined();
});

test('a failed walk on the same land does not create pointless gate trips', async () => {
  const f = travelFixture({ ...moongates.britain, direction: 0 });
  await expect(
    travelJourney(f.ctx, moongates.yew, 1, async () => {
      throw new Blocked('unreachable', 'Locked in');
    })
  ).rejects.toThrow('Locked in');
  expect(f.crossings).toEqual([]);
});

test('a resident exits the dungeon before trying to travel on the surface', async () => {
  const dungeon = required(dungeons.find((d) => d.name === 'Despise'));
  const stair = required(dungeon.floors.flatMap((f) => f.stairs).find((s) => s.toFloor === null));
  expect(dungeonAt(stair.at)?.name).toBe('Despise');
  const f = travelFixture({ ...stair.at, direction: 0 });
  f.stairs.push({ ...stair.to, direction: 0 });
  await travelJourney(f.ctx, stair.to, 1, f.walk);
  expect(f.stairs).toEqual([]);
  expect(f.ctx.position().x).toBe(stair.to.x);
  expect(floorAt(dungeon, f.ctx.position())).toBeUndefined();
});

test('a trip from an island into a dungeon uses a moongate and the surface entrance', async () => {
  const dungeon = required(dungeons.find((d) => d.name === 'Despise'));
  const entry = required(dungeon.entries[0]);
  const f = travelFixture({ ...moongates.jhelom, direction: 0 });
  f.stairs.push({ ...entry.to, direction: 0 });
  await travelJourney(f.ctx, entry.to, 1, f.walk);
  expect(f.crossings).toEqual([entry.gate]);
  expect(f.legs.some((point) => point.x === entry.from.x && point.y === entry.from.y)).toBe(true);
  expect(floorAt(dungeon, f.ctx.position())?.id).toBe(entry.floor);
});

test('dungeon exits follow real stairs through equal-depth floors', () => {
  const point = { x: 100, y: 100, z: 0 };
  const dungeon: Dungeon = {
    name: 'fixture',
    entrance: point,
    entries: [],
    floors: [
      { id: 0, depth: 1, rooms: [], stairs: [{ at: point, to: point, toFloor: 1, width: 1 }] },
      {
        id: 1,
        depth: 1,
        rooms: [],
        stairs: [
          { at: point, to: point, toFloor: 0, width: 1 },
          { at: point, to: point, toFloor: null, width: 1 }
        ]
      }
    ]
  };
  expect(exitStair(dungeon, required(dungeon.floors[0]), point)?.toFloor).toBe(1);
  expect(exitStair(dungeon, required(dungeon.floors[1]), point)?.toFloor).toBeNull();
});
