import { expect, spyOn, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { Hands } from '../src/v2/hands';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import * as planning from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

test('productive recovery after a loss is not blocked for remaining below a previous wealth peak', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  let progress = 100;
  let turns = 0;
  Object.defineProperty(mind, 'progress', { get: () => progress });
  const source = { key: 'recover', steps: [{ verb: 'say' as const, text: 'work' }] };
  const plan = { ...source, source, id: 'recover', value: 10, rate: 10, seconds: 1 };
  const choose = spyOn(planning, 'liveChoices').mockResolvedValue([plan]);
  const act = spyOn(Hands.prototype, 'do').mockImplementation(async (step) => {
    if (step.verb === 'say') {
      progress = turns++ ? progress + 1 : 50;
    }
    return true;
  });
  const events: string[] = [];
  const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [], vendors: [] },
      () => turns >= 8,
      (kind) => events.push(kind)
    );
    expect(turns).toBe(8);
    expect(events).not.toContain('loop-broken');
    expect(events).not.toContain('loop-blocked');
  } finally {
    choose.mockRestore();
    act.mockRestore();
  }
});
