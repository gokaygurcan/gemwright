import { expect, test } from 'bun:test';

import { houseFits, lotGrid, type MapCells } from '../src/house-fit';
import { claimLot, houseOf, refuseLot, updateHouse, useLots } from '../src/house-lots';

// Flat grass at z 0 with one tree and one road tile.
const flat: MapCells = {
  cell: (x, y) => ({
    land: { id: x === 120 && y === 100 ? 0x71 : 3, z: 0 },
    statics: x === 140 && y === 100 ? [{ id: 0xcca, z: 0 }] : []
  }),
  tile: (id, item) => ({ flags: item && id === 0xcca ? 0x40 : 0, height: item ? 20 : 0 })
};

test('a house fits on open flat land, not over a road or a tree', () => {
  expect(houseFits(flat, 100, 100)).toBe(0);
  expect(houseFits(flat, 118, 100)).toBeUndefined();
  expect(houseFits(flat, 137, 100)).toBeUndefined();
  expect(houseFits(flat, 100, 100, [{ x: 95, y: 95, width: 3, height: 3 }])).toBeUndefined();
});

test('lots sit 9 by 13 apart inside the district', () => {
  const grid = lotGrid({ x: 0, y: 0, width: 30, height: 30 });
  expect(grid.map((c) => [c.x, c.y])).toEqual([
    [4, 4],
    [13, 4],
    [22, 4],
    [4, 17],
    [13, 17],
    [22, 17]
  ]);
});

test('each resident claims its own lot, nearest home first, and refused lots stay free', () => {
  useLots([
    { id: 'a', district: 'd', x: 10, y: 10, z: 0 },
    { id: 'b', district: 'd', x: 50, y: 10, z: 0 },
    { id: 'c', district: 'd', x: 90, y: 10, z: 0 }
  ]);
  expect(claimLot('Ann', { x: 0, y: 0 })?.lot).toBe('a');
  expect(claimLot('Bob', { x: 0, y: 0 })?.lot).toBe('b');
  expect(claimLot('Ann', { x: 100, y: 0 })?.lot).toBe('a');
  refuseLot('Bob', 'b', 'blocked');
  expect(houseOf('Bob')).toBeUndefined();
  expect(claimLot('Bob', { x: 0, y: 0 })?.lot).toBe('c');
  updateHouse('Bob', { status: 'placed', house: 'Wooden House' });
  expect(claimLot('Cat', { x: 0, y: 0 })).toBeUndefined();
  expect(houseOf('Bob')?.status).toBe('placed');
});
