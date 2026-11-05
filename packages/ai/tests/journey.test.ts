import { expect, test } from 'bun:test';

import type { Position } from '@gemwright/network/world';

import { areaOfPlace } from '../src/areas';
import { Blocked } from '../src/blocked';
import { threatsNear } from '../src/danger';
import { interruptForDanger } from '../src/danger-response';
import { type Dungeon, dungeonAt, dungeons, exitStair, floorAt } from '../src/dungeons';
import { type Gate, moongates } from '../src/gates';
import { destinationGate, travelJourney } from '../src/journey';
import { lasting } from '../src/lasting';
import { allLinks } from '../src/links';
import { travelByMoongate } from '../src/moongate';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();

function travelFixture(start: Position) {
  const f = socialFixture();
  f.world.position = start;
  const legs: { x: number; y: number; z?: number }[] = [];
  const crossings: Gate[] = [];
  const stairs: Position[] = [];
  // As the server moves a mobile: stepping onto a teleporter's tile sends it on (ServUO
  // Teleporter.OnMoveOver); standing on one does not.
  const arrive = (point: { x: number; y: number; z?: number }) => {
    const link = allLinks().find((l) => l.from.x === point.x && l.from.y === point.y);
    f.world.position = { ...required(f.world.position), ...(link ? link.to : point) };
  };
  const walk = async (point: { x: number; y: number; z?: number }) => {
    legs.push(point);
    if (point.x !== f.world.position?.x || point.y !== f.world.position?.y) arrive(point);
    f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xf6c, position: { ...required(f.world.position) } });
  };
  const steps = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  f.session.walk = async (direction) => {
    const at = required(f.world.position);
    const [dx = 0, dy = 0] = steps[direction & 7] ?? [];
    arrive({ x: at.x + dx, y: at.y + dy, z: at.z });
    return true;
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
  expect(destinationGate({ x: 650, y: 2070 }, areaOfPlace(moongates.skarabrae))).toBe('skarabrae');
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
  // Standing on the way out, as a ghost that fell on it does: off it and back on.
  const f = travelFixture({ ...stair.at, direction: 0 });
  await travelJourney(f.ctx, stair.to, 1, f.walk);
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

test('a resident standing on the Minoc gate crosses despite a saved gate ban', async () => {
  const f = travelFixture({ ...moongates.minoc, direction: 5 });
  const ban = lasting('gate-ban', f.world.serial ?? -1);
  ban.set('minoc>newhaven', Date.now() + 30 * 60_000);
  try {
    await travelByMoongate({ ...f.ctx, navigate: f.walk }, 'newhaven');
    expect(f.crossings).toEqual(['newhaven']);
    expect(f.ctx.position()).toMatchObject(moongates.newhaven);
  } finally {
    ban.set('minoc>newhaven', 0);
  }
});

test('arrival near a threat leaves the resident at the destination for its own safety behavior', async () => {
  const f = travelFixture({ ...moongates.minoc, direction: 5 });
  const reply = f.session.replyGump;
  f.session.replyGump = (...args) => {
    reply(...args);
    f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xf6c, position: { ...f.ctx.position() } });
    if (f.crossings.at(-1) === 'newhaven')
      f.world.entities.set(30, {
        serial: 30,
        kind: 'mobile',
        graphic: 0x12,
        notoriety: 6,
        position: { ...f.ctx.position(), x: f.ctx.position().x + 1 }
      });
  };
  try {
    await travelByMoongate({ ...f.ctx, navigate: f.walk }, 'newhaven');
    expect(f.crossings).toEqual(['newhaven']);
    expect(f.ctx.position()).toMatchObject(moongates.newhaven);
    expect(threatsNear(f.session, f.ctx.position(), 10)).toHaveLength(1);
    expect(() => interruptForDanger(f.session)).toThrow();
  } finally {
    lasting('gate-ban', f.world.serial ?? -1).set('minoc>newhaven', 0);
  }
});

test('an unconfirmed crossing fails without inventing a ten-minute gate closure', async () => {
  const f = travelFixture({ ...moongates.minoc, direction: 5 });
  const reply = f.session.replyGump;
  f.session.replyGump = () => {};
  await expect(travelByMoongate({ ...f.ctx, navigate: f.walk }, 'newhaven')).rejects.toThrow('did not take me');
  f.session.replyGump = reply;
  try {
    await travelByMoongate({ ...f.ctx, navigate: f.walk }, 'newhaven');
    expect(f.crossings).toEqual(['newhaven']);
  } finally {
    lasting('gate-ban', f.world.serial ?? -1).set('minoc>newhaven', 0);
  }
});
