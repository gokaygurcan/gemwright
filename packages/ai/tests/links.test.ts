import { expect, test } from 'bun:test';

import { parseTeleporters } from '../src/links';

test("a mine's two-way teleporter is known both ways, so a ghost inside finds the way out", () => {
  const links = parseTeleporters('3508,2777,26,Trammel,5912,355,0,Trammel,True\n');
  expect(links).toEqual([
    { from: { x: 3508, y: 2777, z: 26 }, to: { x: 5912, y: 355, z: 0 } },
    { from: { x: 5912, y: 355, z: 0 }, to: { x: 3508, y: 2777, z: 26 } }
  ]);
});
