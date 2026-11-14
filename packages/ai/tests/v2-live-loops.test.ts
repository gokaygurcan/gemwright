import { expect, spyOn, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import type { Terrain } from '../src/terrain';
import { Hands } from '../src/v2/hands';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import * as planning from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

test('a resident with no worthwhile work changes location instead of resting indefinitely', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  let stopped = false;
  const walks: number[] = [];
  const session = {
    world,
    phase: 'ready',
    refreshSkills: async () => {},
    setWarMode: (enabled: boolean) => {
      world.warMode = enabled;
    },
    walk: async (direction: number) => {
      walks.push(direction);
      const [dx, dy] = [
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1]
      ][direction] ?? [0, 0];
      const here = world.position;
      if (!here) throw new Error('Missing player position');
      world.position = { ...here, x: here.x + (dx ?? 0), y: here.y + (dy ?? 0), direction };
      return true;
    }
  } as unknown as PlayerSession;
  const timer = setTimeout(() => {
    stopped = true;
  }, 100);
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [{ x: 130, y: 100 }], vendors: [] },
      () => stopped,
      (kind, data) => {
        if (kind === 'course-changed') {
          expect(data).toMatchObject({ reached: true });
          stopped = true;
        }
      }
    );
    expect(walks.length).toBeGreaterThan(0);
    expect(world.position?.x).not.toBe(100);
  } finally {
    clearTimeout(timer);
  }
}, 7000);

test('unreachable recovery routes are attempted only once before an explicit failure', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.routeScope = 'unreachable-recovery-fixture';
  const destinations: string[] = [];
  const terrain = {
    bestTiles: () => [],
    findTiles: () => [],
    pathAsync: async (_here: object, goal: { x: number; y: number }) => {
      destinations.push(`${goal.x},${goal.y}`);
      return [];
    }
  } as unknown as Terrain;
  const session = {
    world,
    phase: 'ready',
    refreshSkills: async () => {},
    setWarMode: (enabled: boolean) => {
      world.warMode = enabled;
    }
  } as unknown as PlayerSession;
  let helpRequests = 0;
  session.requestHelp = () => {
    helpRequests++;
  };
  const events: string[] = [];
  await expect(
    live(
      session,
      mind,
      terrain,
      {
        shrines: [],
        bankers: [
          { x: 130, y: 100 },
          { x: 130, y: 100 }
        ],
        vendors: []
      },
      () => false,
      (kind) => events.push(kind)
    )
  ).rejects.toThrow('no alternative destination reachable');
  expect(destinations.length).toBeGreaterThan(1);
  expect(destinations.length).toBeLessThanOrEqual(8);
  expect(new Set(destinations).size).toBe(destinations.length);
  expect(events).toContain('loop-blocked');
  expect(helpRequests).toBe(1);
  expect(mind.care.helpAfter).toBeGreaterThan(Date.now());
}, 10_000);

for (const completed of [false, true]) {
  test(`the live loop changes plans after ${completed ? 'six empty completions' : 'three refusals'}`, async () => {
    const world = new WorldView();
    world.serial = 1;
    world.position = { x: 100, y: 100, z: 0, direction: 0 };
    const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
    const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
    let stopped = false;
    const tried: string[] = [];
    const plans = ['first', 'different'].map((key, index) => {
      const source = { key, steps: [{ verb: 'say' as const, text: key }] };
      return { ...source, source, id: key, value: 10 - index, rate: 10 - index, seconds: 1 };
    });
    const choose = spyOn(planning, 'liveChoices').mockResolvedValue(plans);
    const act = spyOn(Hands.prototype, 'do').mockImplementation(async (step) => {
      if (step.verb === 'say') {
        tried.push(step.text);
        if (step.text === 'different') stopped = true;
        return completed;
      }
      return true;
    });
    const timer = setTimeout(() => {
      stopped = true;
    }, 12_000);
    try {
      await live(
        session,
        mind,
        undefined,
        { shrines: [], bankers: [], vendors: [] },
        () => stopped,
        () => {}
      );
      expect(tried).toEqual([...Array(completed ? 6 : 3).fill('first'), 'different']);
    } finally {
      clearTimeout(timer);
      choose.mockRestore();
      act.mockRestore();
    }
  }, 15_000);
}

test('urgent safety work is performed even when its score would otherwise trigger relocation', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
  let stopped = false;
  const source = { key: 'leave danger', urgent: true, steps: [{ verb: 'escape' as const }] };
  const choose = spyOn(planning, 'liveChoices').mockResolvedValue([
    { ...source, source, id: 'escape', value: -1, rate: -1, seconds: 1 }
  ]);
  const performed: string[] = [];
  const act = spyOn(Hands.prototype, 'do').mockImplementation(async (step) => {
    performed.push(step.verb);
    if (step.verb === 'escape') stopped = true;
    return true;
  });
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [], vendors: [] },
      () => stopped,
      () => {}
    );
    expect(performed).toContain('escape');
    expect(performed).not.toContain('walk');
  } finally {
    choose.mockRestore();
    act.mockRestore();
  }
});

test('a plan abandoned for a better one is an unrealized experience and never counts against it', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
  let stopped = false;
  const tried: string[] = [];
  const plan = (key: string, value: number) => {
    const source = { key, steps: [{ verb: 'say' as const, text: key }] };
    return { ...source, source, id: key, value, rate: value, seconds: 1 };
  };
  // Weighed again every time the world changes, the better course wins: the live loop breaks the
  // walk off itself. That must never read as the walk having failed.
  let calls = 0;
  const choose = spyOn(planning, 'liveChoices').mockImplementation(async () => {
    calls++;
    return calls % 2 ? [plan('first', 10), plan('different', 5)] : [plan('different', 30), plan('first', 10)];
  });
  const act = spyOn(Hands.prototype, 'do').mockImplementation(async (step, going) => {
    if (step.verb !== 'say') return true;
    tried.push(step.text);
    if (tried.length >= 6) {
      stopped = true;
      return true;
    }
    mind.observe({
      resident: 'r',
      at: Date.now(),
      kind: 'seen',
      data: { serial: 900, kind: 'mobile', is: ['Mongbat'] }
    });
    return (await going?.()) ?? true;
  });
  const timer = setTimeout(() => {
    stopped = true;
  }, 30_000);
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [], vendors: [] },
      () => stopped,
      () => {}
    );
    // Six times over: had a broken-off walk counted as a failure, the third would have been its
    // last and the other course would have taken its place.
    expect(tried.length).toBeGreaterThanOrEqual(6);
    expect(tried.every((text) => text === 'first')).toBe(true);
  } finally {
    clearTimeout(timer);
    choose.mockRestore();
    act.mockRestore();
  }
}, 40_000);
