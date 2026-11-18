import { expect, test } from 'bun:test';

import { Hands } from '../src/hands';
import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import { advance, choices } from '../src/planning';
import { traitsOf } from '../src/traits';
import { bankShard } from './fixtures/bank-shard';

test('repeated autonomous bank and vendor cycles conserve goods and money without overload or transfer loops', async () => {
  const shard = bankShard();
  const events: { kind: string; data: object }[] = [];
  let mind = new Mind('r', (e) => events.push(e), traitsOf([], () => 0.5).traits);
  mind.acting = true;
  let stop = perceive(shard.session, 'r', (e) => {
    events.push(e);
    mind.observe(e);
  });
  const hands = new Hands(
    shard.session,
    undefined,
    () => undefined,
    (id) => mind.call(id)
  );
  const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Blacksmith'] }] };
  let consecutiveTransfers = 0;
  try {
    for (let turn = 0; turn < 60 && shard.state().sold < 3000; turn++) {
      const best = choices(mind, undefined, new Set(), places)[0];
      expect(best).toBeDefined();
      if (!best || best.rate <= -1) throw new Error(`No productive plan: ${best?.key}`);
      if (best.key === 'deposit') consecutiveTransfers++;
      else consecutiveTransfers = 0;
      expect(consecutiveTransfers).toBeLessThan(2);
      let remaining = best.source;
      for (const step of best.steps) {
        const going = () => {
          const alternatives = choices(mind, undefined, new Set(), places, remaining);
          const current = alternatives.find((p) => p.id === best.id)?.rate ?? best.rate;
          const other = alternatives[0];
          return !other || other.id === best.id || other.rate - current <= mind.temper.patience * Math.abs(current);
        };
        const did = await hands.do(step, going);
        if (!did) throw new Error(`Refused ${best.key}: ${JSON.stringify(step)}; ${JSON.stringify(shard.state())}`);
        expect(did).toBe(true);
        remaining = advance(remaining);
      }
      mind.complete(best.id, true);
      if (turn === 15) {
        stop();
        const resumed = new Mind('r', (e) => events.push(e), traitsOf([], () => 0.5).traits);
        resumed.restore(structuredClone(mind.snapshot()));
        resumed.acting = true;
        mind = resumed;
        stop = perceive(shard.session, 'r', (e) => {
          events.push(e);
          mind.observe(e);
        });
      }
      expect(shard.world.status?.weight).toBeLessThanOrEqual(150);
      expect(
        [...mind.belongings()].filter(([, i]) => i.name === 'IronIngot').reduce((sum, [, i]) => sum + i.amount, 0)
      ).toBe(3000 - shard.state().sold);
    }
    expect(shard.state().sales).toBeGreaterThan(10);
    expect(shard.state().sold).toBe(3000);
    expect(shard.moves.every((m) => m.weight <= 150)).toBe(true);
    expect([...shard.items.values()].filter((i) => i.graphic === 3821).reduce((sum, i) => sum + i.amount, 0)).toBe(
      12000
    );
  } finally {
    stop();
  }
});
