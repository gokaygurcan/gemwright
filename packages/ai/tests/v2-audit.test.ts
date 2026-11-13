import { expect, spyOn, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { Hands } from '../src/v2/hands';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import * as planning from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

test('history retains repeated decisions, selected plans and measurable progress for an audit', async () => {
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
  const source = { key: 'work', steps: [{ verb: 'say' as const, text: 'work' }] };
  const plan = { ...source, source, id: 'work', value: 10, rate: 5, seconds: 2 };
  const choose = spyOn(planning, 'liveChoices').mockResolvedValue([plan]);
  const act = spyOn(Hands.prototype, 'do').mockResolvedValue(true);
  const events: { kind: string; data: object }[] = [];
  let ended = 0;
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [], vendors: [] },
      () => ended >= 2,
      (kind, data) => {
        events.push({ kind, data });
        if (kind === 'plan-ended') ended++;
      }
    );
    const choices = events.filter((e) => e.kind === 'considered');
    expect(choices).toHaveLength(2);
    expect(choices[0]?.data).toMatchObject({
      id: 'work',
      steps: source.steps,
      options: [{ id: 'work', key: 'work', value: 10, rate: 5, seconds: 2, blocked: false }]
    });
    expect(events.filter((e) => e.kind === 'plan-ended').map((e) => e.data)).toEqual([
      expect.objectContaining({ id: 'work', result: 'completed', done: 1, total: 1, advanced: false }),
      expect.objectContaining({ id: 'work', result: 'completed', done: 1, total: 1, advanced: false })
    ]);
  } finally {
    choose.mockRestore();
    act.mockRestore();
  }
});

test('an interrupted plan records the better opportunity and the patience comparison', async () => {
  const world = new WorldView();
  world.serial = 1;
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const session = { world, phase: 'ready', refreshSkills: async () => {} } as unknown as PlayerSession;
  const source = { key: 'work', steps: [{ verb: 'say' as const, text: 'work' }] };
  const current = { ...source, source, id: 'work', value: 10, rate: 5, seconds: 2 };
  const other = { ...current, id: 'other', key: 'better work', rate: 100 };
  const choose = spyOn(planning, 'liveChoices').mockResolvedValueOnce([current]).mockResolvedValue([other, current]);
  const act = spyOn(Hands.prototype, 'do').mockImplementation(async (step, going) => {
    if (step.verb !== 'say') return true;
    mind.revision++;
    // The step never waits for the weighing; the next check after it stops the plan.
    expect(await going()).toBe(true);
    await Bun.sleep(0);
    return going();
  });
  let ended: object | undefined;
  try {
    await live(
      session,
      mind,
      undefined,
      { shrines: [], bankers: [], vendors: [] },
      () => !!ended,
      (kind, data) => {
        if (kind === 'plan-ended') ended = data;
      }
    );
    expect(ended).toMatchObject({
      id: 'work',
      result: 'interrupted',
      done: 0,
      total: 1,
      interruption: {
        reason: 'better opportunity',
        keeping: 5,
        patience: mind.temper.patience,
        alternative: { id: 'other', key: 'better work', rate: 100 }
      }
    });
  } finally {
    choose.mockRestore();
    act.mockRestore();
  }
});
