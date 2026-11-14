import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import { Hands } from '../src/v2/hands';
import { heard } from './fixtures/journal';

const steps = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
] as const;

// A client that turns before it steps, raises a cursor for a tool and is answered for a target.
function client() {
  const sent: string[] = [];
  const world = heard({
    serial: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    entities: new Map([[5, { serial: 5, kind: 'item', graphic: 3718 }]]),
    journal: [] as { cliloc?: number }[],
    target: null as object | null
  });
  const session = {
    world,
    walk: async (direction: number) => {
      if (world.position.direction !== direction) world.position.direction = direction;
      else {
        const [dx, dy] = steps[direction] ?? [0, 0];
        world.position = { ...world.position, x: world.position.x + dx, y: world.position.y + dy };
      }
      return true;
    },
    use: (serial: number) => {
      sent.push(`use ${serial}`);
      world.target = {};
    },
    target: (location: { x: number; y: number }) => {
      sent.push(`target ${location.x},${location.y}`);
      world.target = null;
      world.journal.push({ cliloc: 503040 });
    }
  } as unknown as PlayerSession;
  return { session, sent, world };
}

// Mining a rock five tiles east: walk to within two of it, use the pickaxe, target the rock.
test('hands walk within reach, use the tool and answer its cursor', async () => {
  const { session, sent, world } = client();
  const terrain = {
    pathAsync: async (start: { x: number; y: number }, goal: { x: number; y: number }, range: number) =>
      Array.from({ length: Math.max(0, goal.x - start.x - range) }, (_, i) => ({ x: start.x + i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  const hands = new Hands(session, terrain);
  const going = () => true;
  expect(await hands.do({ verb: 'walk', x: 15, y: 10, range: 2 }, going)).toBe(true);
  expect(world.position).toMatchObject({ x: 13, y: 10 });
  expect(await hands.do({ verb: 'use', serial: 5 }, going)).toBe(true);
  expect(await hands.do({ verb: 'target', x: 15, y: 10, z: 0, graphic: 0 }, going)).toBe(true);
  expect(sent).toEqual(['use 5', 'target 15,10']);
});

// A creature it cannot reach (across water, up on a roof): it gives up rather than trying again and
// again without ever letting the rest of the program run.
test('a fight it cannot close in on is given up', async () => {
  const { session, world } = client();
  world.entities.set(9, { serial: 9, kind: 'mobile', graphic: 6, position: { x: 20, y: 10, z: 0 } } as never);
  Object.assign(session, { attack: async () => Object.assign(world, { combatant: 9 }) });
  const terrain = { pathAsync: async () => [] } as unknown as Terrain;
  expect(await new Hands(session, terrain).do({ verb: 'fight', serial: 9 }, () => true)).toBe(false);
});

// A closed door south of it: the step is refused until it opens the door, as a player does.
test('a closed door in the way is opened', async () => {
  const { session, world, sent } = client();
  let open = false;
  world.entities.set(7, { serial: 7, kind: 'item', graphic: 1653, position: { x: 10, y: 11, z: 0 } } as never);
  const walk = session.walk;
  Object.assign(session, {
    walk: async (direction: number) =>
      direction === 4 && world.position.direction === 4 && !open ? false : walk(direction),
    use: (serial: number) => {
      sent.push(`use ${serial}`);
      open = serial === 7;
    }
  });
  const terrain = {
    pathAsync: async () => [
      { x: 10, y: 11, z: 0 },
      { x: 10, y: 12, z: 0 }
    ]
  } as unknown as Terrain;
  expect(await new Hands(session, terrain).do({ verb: 'walk', x: 10, y: 12, range: 0 }, () => true)).toBe(true);
  expect(sent).toEqual(['use 7']);
});

// Its horse standing beside it and somewhere far to go: it gets on the horse first.
test('it rides its own horse when it has somewhere far to go', async () => {
  const { session, world, sent } = client();
  world.entities.set(30, { serial: 30, kind: 'mobile', graphic: 228, position: { x: 11, y: 10, z: 0 } } as never);
  Object.assign(session, {
    use: (serial: number) => {
      sent.push(`use ${serial}`);
      if (serial === 30)
        world.entities.set(31, { serial: 31, kind: 'item', graphic: 16033, parent: 1, layer: 25 } as never);
    }
  });
  const terrain = {
    pathAsync: async (start: { x: number }, goal: { x: number }) =>
      Array.from({ length: goal.x - start.x }, (_, i) => ({ x: start.x + i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  const hands = new Hands(session, terrain, () => 30);
  expect(await hands.do({ verb: 'walk', x: 40, y: 10, range: 0 }, () => true)).toBe(true);
  expect(sent[0]).toBe('use 30');
});

// Its kill's corpse beside it: opened, and the gold in it taken into its pack; the worthless bones left.
test('it loots what is worth something from the corpse of its kill', async () => {
  const { session, world, sent } = client();
  world.entities.set(2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 } as never);
  world.entities.set(50, { serial: 50, kind: 'item', graphic: 8198, position: { x: 11, y: 10, z: 0 } } as never);
  world.entities.set(49, { serial: 49, kind: 'mobile', position: { x: 11, y: 10, z: 0 } } as never);
  const deaths = new Map();
  Object.assign(world, { deaths });
  Object.assign(session, {
    attack: async () => {
      world.entities.delete(49);
      deaths.set(49, { corpse: 50 });
    },
    use: (serial: number) => {
      sent.push(`use ${serial}`);
      world.entities.set(60, { serial: 60, kind: 'item', graphic: 3821, parent: 50 } as never);
      world.entities.set(61, { serial: 61, kind: 'item', graphic: 3966, parent: 50 } as never);
    },
    moveItem: async (serial: number, container: number) => sent.push(`move ${serial} to ${container}`)
  });
  const names: Record<number, string> = {
    50: 'Corpse of Mongbat',
    60: 'Gold in Corpse of Mongbat',
    61: 'Bone in Corpse of Mongbat'
  };
  const hands = new Hands(
    session,
    undefined,
    () => undefined,
    (serial) => names[serial],
    (serial) => (serial === 60 ? 12 : 0)
  );
  expect(await hands.do({ verb: 'fight', serial: 49 }, () => true)).toBe(true);
  expect(sent).toEqual(['use 50', 'move 60 to 2']);
});

// A step or two to go: not worth getting on the horse only to get off it again.
test('it walks a short way rather than mounting for it', async () => {
  const { session, world, sent } = client();
  world.entities.set(30, { serial: 30, kind: 'mobile', graphic: 228, position: { x: 11, y: 10, z: 0 } } as never);
  Object.assign(session, { use: (serial: number) => sent.push(`use ${serial}`) });
  const terrain = {
    pathAsync: async (start: { x: number }, goal: { x: number }) =>
      Array.from({ length: goal.x - start.x }, (_, i) => ({ x: start.x + i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  expect(await new Hands(session, terrain, () => 30).do({ verb: 'walk', x: 13, y: 10, range: 1 }, () => true)).toBe(
    true
  );
  expect(sent).toEqual([]);
});

test('graph waypoints inside unrelated player houses are skipped', async () => {
  const { session } = client();
  const destinations: number[] = [];
  const terrain = {
    geometry: {
      revision: 'house',
      tiles: [],
      houses: [{ serial: 50, minX: 55, maxX: 65, minY: 5, maxY: 15, unknown: false }]
    },
    pathAsync: async (start: { x: number }, goal: { x: number }, range: number) => {
      destinations.push(goal.x);
      return Array.from({ length: Math.max(0, goal.x - start.x - range) }, (_, i) => ({
        x: start.x + i + 1,
        y: 10,
        z: 0
      }));
    }
  } as unknown as Terrain;
  const hands = new Hands(session, terrain);
  hands.reach = {
    route: () => ({
      steps: 90,
      legs: [
        { kind: 'walk', x: 60, y: 10, z: 0 },
        { kind: 'walk', x: 100, y: 10, z: 0 }
      ]
    })
  } as never;
  expect(await hands.do({ verb: 'walk', x: 100, y: 10, range: 0 }, () => true)).toBe(true);
  expect(destinations).toEqual([100]);
});

test('checking funds waits for a fresh banker reply and accepts a zero balance', async () => {
  const { session, world, sent } = client();
  world.journal.push({ cliloc: 1042759, arguments: '999' } as never);
  Object.assign(session, {
    say: (text: string) => {
      sent.push(text);
      world.journal.push({ cliloc: 1042759, arguments: '0' } as never);
    }
  });
  expect(await new Hands(session, undefined).do({ verb: 'balance' }, () => true)).toBe(true);
  expect(sent).toEqual(['balance']);
});

// A step the shard refuses leaves the client unsure where it stands: it asks (0x22) before going on.
test('a refused step is followed by asking the shard where it stands', async () => {
  const { session } = client();
  let asked = 0;
  Object.assign(session, {
    walk: async () => false,
    resyncPosition: async () => {
      asked++;
      return true;
    }
  });
  const terrain = {
    pathAsync: async (start: { x: number; y: number }) => [{ x: start.x + 1, y: start.y, z: 0 }]
  } as unknown as Terrain;
  expect(await new Hands(session, terrain).do({ verb: 'walk', x: 15, y: 10, range: 0 }, () => true)).toBe(false);
  expect(asked).toBeGreaterThan(0);
});

// Put somewhere else by a teleporter, it asks the shard where exactly it now stands.
test('after a teleporter it asks the shard where it stands', async () => {
  const { session, world } = client();
  let asked = 0;
  Object.assign(session, {
    walk: async (direction: number) => {
      if (world.position.direction !== direction) {
        world.position.direction = direction;
        return true;
      }
      const [dx, dy] = steps[direction] ?? [0, 0];
      world.position = { ...world.position, x: world.position.x + dx, y: world.position.y + dy };
      // Stepping on the teleporter at 12,10 puts it far away.
      if (world.position.x === 12) world.position = { ...world.position, x: 500, y: 500 };
      return true;
    },
    resyncPosition: async () => {
      asked++;
      return true;
    }
  });
  const terrain = {
    pathAsync: async (start: { x: number; y: number }, goal: { x: number; y: number }) =>
      start.x < goal.x ? [{ x: start.x + 1, y: start.y, z: 0 }] : []
  } as unknown as Terrain;
  const hands = new Hands(session, terrain);
  hands.reach = {
    route: () => ({
      steps: 2,
      legs: [
        { kind: 'teleport', x: 12, y: 10, z: 0 },
        { kind: 'walk', x: 500, y: 500, z: 0 }
      ]
    })
  } as unknown as NonNullable<Hands['reach']>;
  expect(await hands.do({ verb: 'walk', x: 500, y: 500, range: 0 }, () => true)).toBe(true);
  expect(asked).toBe(1);
});
