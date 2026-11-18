import { expect, test } from 'bun:test';

import { WorldView } from '../src/world';

function world() {
  const view = new WorldView();
  view.serial = 1;
  view.position = { x: 100, y: 100, z: 0, direction: 0 };
  view.put({ serial: 1, kind: 'mobile', graphic: 400, position: { x: 100, y: 100, z: 0, direction: 0 } });
  view.put({ serial: 10, kind: 'item', graphic: 0xe75, parent: 1, layer: 21 });
  view.put({ serial: 42, kind: 'item', graphic: 0xf43, parent: 10 });
  view.put({ serial: 2, kind: 'mobile', graphic: 400, position: { x: 118, y: 100, z: 0, direction: 0 } });
  view.put({ serial: 50, kind: 'item', graphic: 0x2006, position: { x: 100, y: 118, z: 0, direction: 0 } });
  view.put({ serial: 51, kind: 'item', graphic: 0xeed, parent: 50 });
  return view;
}

// ServUO never removes what leaves range by walking; the client sees 18 tiles and nothing beyond.
test('walking away leaves behind what is more than 18 tiles off, with what it holds', () => {
  const view = world();
  view.position = { x: 99, y: 99, z: 0, direction: 7 };
  expect(view.entities.has(2)).toBe(false);
  expect(view.entities.has(50)).toBe(false);
  expect(view.entities.has(51)).toBe(false);
  expect(view.entities.has(42)).toBe(true);
  expect(view.entities.has(1)).toBe(true);
});

test('something that walks beyond 18 tiles is out of view', () => {
  const view = world();
  view.put({ serial: 2, kind: 'mobile', graphic: 400, position: { x: 119, y: 100, z: 0, direction: 0 } });
  expect(view.entities.has(2)).toBe(false);
});

test('a step closes what was shown', () => {
  const view = world();
  view.shown.add(10);
  view.position = { x: 101, y: 100, z: 0, direction: 2 };
  expect(view.shown.size).toBe(0);
});
