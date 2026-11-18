import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { History } from '../src/history';
import { digest, liveChoices } from '../src/planning';
import { awaken, placesOf } from '../src/shadow';
import { simulate, type Trace } from '../src/simulate';
import { traitsOf } from '../src/traits';

const where = { x: 3500, y: 2600, z: 0, map: 1 };

test('a traced decision weighed again from its history comes to the same result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-simulate-'));
  const history = new History(join(dir, 'history.sqlite'));
  let tick = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => (tick += 10));
  try {
    history.record({ resident: 'r', at: 0, kind: 'born', data: { traits: traitsOf([], () => 0.5).traits } });
    history.saveWake({ resident: 'r', at: 1, through: history.mark(), after: 0, trade: [], supporting: [] });
    const wake = history.wakeBefore('r', history.mark() + 1);
    if (!wake) throw new Error('No wake was saved');
    const { mind, places } = awaken(history, wake, () => {});
    mind.awake = true;
    const perceive = (kind: string, data: object) => {
      const event = { resident: 'r', at: Date.now(), kind, data, via: 'perceived' as const, where };
      history.record(event);
      places.observe(event);
      mind.observe(event);
    };
    perceive('awake', { serial: 1, self: {} });
    perceive('self', { weight: { current: 493, max: 471 } });
    perceive('revealed', { serial: 2, kind: 'item', parent: 1, layer: 21, is: ['Backpack'] });
    perceive('revealed', { serial: 10, kind: 'item', parent: 2, graphic: 0x19b8, amount: 40, is: ['IronOre'] });
    // Something it perceives while it is still weighing, met where it was met.
    let during = 0;
    const trace: Trace = { from: history.mark(), now: Date.now(), slices: [], tape: [] };
    const valued = await liveChoices(
      mind,
      undefined,
      new Set(),
      placesOf(history, mind),
      () => false,
      undefined,
      false,
      (steps, at) => {
        if (!trace.slices.length) {
          during++;
          perceive('changed', { serial: 10, properties: [{ cliloc: 1072789, arguments: '160' }] });
        }
        trace.slices.push([steps, history.mark(), at]);
      }
    );
    const id = history.record({
      resident: 'r',
      at: Date.now(),
      kind: 'considered',
      data: { trace: { ...trace, digest: digest(valued) }, options: valued?.slice(0, 5) },
      via: 'told'
    });
    const simulation = simulate(history, id);
    expect(during).toBe(1);
    expect(simulation.during).toBe(1);
    expect(simulation.simulated.options.map((o) => o.id)).toEqual(valued?.slice(0, 5).map((o) => o.id) ?? []);
    expect(simulation.same).toBe(true);
  } finally {
    clock.mockRestore();
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only each resident's latest wakings keep the megabytes of its mind", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-wakes-'));
  const history = new History(join(dir, 'history.sqlite'));
  try {
    for (let i = 0; i < 5; i++)
      history.saveWake({ resident: 'r', at: i, through: i, after: 0, trade: [], supporting: [], state: { i } });
    history.saveWake({ resident: 'other', at: 9, through: 9, after: 0, trade: [], supporting: [], state: { i: 9 } });
    expect(history.wakes('r').map((wake) => wake.state)).toEqual([undefined, undefined, { i: 2 }, { i: 3 }, { i: 4 }]);
    expect(history.wakes('other')[0]?.state).toEqual({ i: 9 });
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
