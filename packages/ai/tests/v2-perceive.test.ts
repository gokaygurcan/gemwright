import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import type { HistoryEvent } from '../src/v2/history';
import { perceive } from '../src/v2/perceive';

// Opening a bag shows what was already in it; only what arrives afterwards is gained.
test('opening a container reveals its contents rather than gaining them', () => {
  const world = new WorldView();
  world.serial = 1;
  world.put({ serial: 1, kind: 'mobile', graphic: 400, position: { x: 1, y: 1, z: 0, direction: 0 } });
  world.put({ serial: 2, kind: 'item', graphic: 0xe75, layer: 21, parent: 1 });
  const events: HistoryEvent[] = [];
  const stop = perceive({ world } as unknown as PlayerSession, 'r', (e) => events.push(e));
  const contents = Buffer.alloc(25);
  contents.writeUInt8(0x3c, 0);
  contents.writeUInt16BE(25, 1);
  contents.writeUInt16BE(1, 3);
  contents.writeUInt32BE(3, 5);
  contents.writeUInt16BE(0x1f03, 9);
  contents.writeUInt16BE(1, 12);
  contents.writeUInt32BE(2, 19);
  world.apply(contents);
  world.put({ serial: 4, kind: 'item', graphic: 0x19b9, amount: 2, parent: 2 });
  stop();
  expect(
    events
      .filter((e) => ['revealed', 'gained'].includes(e.kind))
      .map((e) => [e.kind, (e.data as { serial: number }).serial])
  ).toEqual([
    ['revealed', 2],
    ['revealed', 3],
    ['gained', 4]
  ]);
});

// The bank box and what is in it were always its own: opening it shows them.
test('opening the bank reveals what is in it', () => {
  const world = new WorldView();
  world.serial = 1;
  world.put({ serial: 1, kind: 'mobile', graphic: 400, position: { x: 1, y: 1, z: 0, direction: 0 } });
  const events: HistoryEvent[] = [];
  const stop = perceive({ world } as unknown as PlayerSession, 'r', (e) => events.push(e));
  world.put({ serial: 5, kind: 'item', graphic: 0xe7c, layer: 29, parent: 1 });
  world.put({ serial: 6, kind: 'item', graphic: 0x1b76, parent: 5 });
  stop();
  expect(
    events
      .filter((e) => ['revealed', 'gained'].includes(e.kind))
      .map((e) => [e.kind, (e.data as { serial: number }).serial])
  ).toEqual([
    ['revealed', 5],
    ['revealed', 6]
  ]);
});

// Hovering a pile of ore: its properties arrive, and what it is with them.
test("an item's hover is perceived with what it shows it to be", () => {
  const world = new WorldView();
  world.serial = 1;
  world.put({ serial: 1, kind: 'mobile', graphic: 400, position: { x: 1, y: 1, z: 0, direction: 0 } });
  world.put({ serial: 2, kind: 'item', graphic: 0xe75, layer: 21, parent: 1 });
  const events: HistoryEvent[] = [];
  const stop = perceive({ world } as unknown as PlayerSession, 'r', (e) => events.push(e));
  world.put({ serial: 4, kind: 'item', graphic: 0x19b8, amount: 3, parent: 2 });
  const ore = world.entities.get(4);
  if (ore)
    world.put({
      ...ore,
      properties: [
        { cliloc: 1026583, arguments: '' },
        { cliloc: 1053101, arguments: '' }
      ]
    });
  stop();
  expect(events.filter((e) => e.kind === 'changed').map((e) => e.data)).toEqual([
    {
      serial: 4,
      properties: [
        { cliloc: 1026583, arguments: '' },
        { cliloc: 1053101, arguments: '' }
      ],
      is: ['ValoriteOre']
    }
  ]);
});
