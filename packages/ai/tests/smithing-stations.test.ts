import { expect, test } from 'bun:test';

import { atSmithingStation, rejectSmithingStation } from '../src/smithing-stations';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

let serial = 90000;
function stationFixture() {
  const f = socialFixture('craftsman');
  const id = serial++;
  f.world.position = { x: 2560, y: 502, z: 0, direction: 0 };
  f.terrain.findStatics = () => [];
  f.terrain.pathAsync = async (_from, goal) => [{ ...goal, z: 0 }];
  const fixtures = () => {
    f.world.entities.set(20, {
      serial: 20,
      kind: 'item',
      graphic: 0xfaf,
      position: { x: 2560, y: 501, z: 0, direction: 0 }
    });
    f.world.entities.set(21, {
      serial: 21,
      kind: 'item',
      graphic: 0xfb1,
      position: { x: 2561, y: 501, z: 0, direction: 0 }
    });
  };
  fixtures();
  const legs: { x: number; y: number; z?: number }[] = [];
  const ctx = {
    ...f.ctx,
    serial: id,
    navigate: async (point: { x: number; y: number; z?: number }) => {
      legs.push(point);
      f.world.position = { ...required(f.world.position), ...point };
      if (Math.abs(point.x - 2560) < 5) fixtures();
    }
  };
  return { ...f, ctx, legs };
}

test('a visible server-placed anvil and forge are remembered across a restart and revisited after banking', async () => {
  const f = stationFixture();
  expect(await atSmithingStation(f.ctx)).toBe(true);
  const saved = JSON.stringify(f.checkpoint.landmarks);
  f.checkpoint.landmarks = JSON.parse(saved);
  f.world.position = { x: 2503, y: 552, z: 0, direction: 0 };
  f.world.entities.delete(20);
  f.world.entities.delete(21);
  expect(await atSmithingStation(f.ctx)).toBe(true);
  expect(f.legs[0]).toMatchObject({ x: 2560, y: 502, z: 0 });
  expect(f.ctx.position().x).toBe(2560);
  expect(f.checkpoint.landmarks?.smithies).toHaveLength(1);
});

test('a server-rejected station gives way to another anvil-forge pair', async () => {
  const f = stationFixture();
  f.world.entities.set(22, {
    serial: 22,
    kind: 'item',
    graphic: 0xfb0,
    position: { x: 2534, y: 571, z: 5, direction: 0 }
  });
  f.world.entities.set(23, {
    serial: 23,
    kind: 'item',
    graphic: 0xfb1,
    position: { x: 2535, y: 571, z: 5, direction: 0 }
  });
  expect(await atSmithingStation(f.ctx)).toBe(true);
  rejectSmithingStation(f.ctx);
  expect(await atSmithingStation(f.ctx)).toBe(true);
  const station = required(f.checkpoint.landmarks?.smithies?.[0]);
  expect(station.anvil.x).toBe(2534);
  expect(station.stand.z).toBe(5);
});

test('a forge known from smelting can lead to discovery of its nearby anvil', async () => {
  const f = stationFixture();
  f.world.position = { x: 2503, y: 552, z: 0, direction: 0 };
  f.world.entities.delete(20);
  f.world.entities.delete(21);
  f.checkpoint.landmarks = { forges: [{ x: 2561, y: 501, z: 0 }] };
  expect(await atSmithingStation(f.ctx)).toBe(true);
  expect(f.checkpoint.landmarks.smithies).toHaveLength(1);
});
