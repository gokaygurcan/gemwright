import { expect, test } from 'bun:test';

import { Hands } from '../src/hands';
import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import { advance, choices } from '../src/planning';
import { traitsOf } from '../src/traits';
import { trainingShard } from './fixtures/training-shard';

for (const skill of ['Tinkering', 'Carpentry', 'Inscribe', 'Magery', 'Necromancy']) {
  test(`${skill}: empty supplies become practice, depletion and refill through the planner and client`, async () => {
    const shard = trainingShard(skill);
    const events: { kind: string; data: object }[] = [];
    const mind = new Mind(
      'pupil',
      (e) => events.push(e),
      { ...traitsOf([], () => 0.5).traits, curiosity: 0, diligence: 1 },
      [],
      ['Mining'],
      [skill]
    );
    mind.acting = true;
    const stop = perceive(shard.session, 'pupil', (e) => {
      events.push(e);
      mind.observe(e);
    });
    const hands = new Hands(
      shard.session,
      undefined,
      () => mind.mount,
      (id) => mind.call(id)
    );
    hands.notice = (kind, data) => mind.notice(kind, data);
    const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Mage', 'Tinker', 'Carpenter'] }] };
    let attempts = 0;
    const trace: string[] = [];
    try {
      for (let turn = 0; turn < 40 && shard.crafts.length + shard.casts.length < 3; turn++) {
        const plan = choices(mind, undefined, new Set(), places)[0];
        if (!plan)
          throw new Error(
            `No ${skill} plan after ${turn} turns: ${trace.join('; ')}; spend ${mind.care.trainingSpent()}; known ${[...mind.care.knownSpells]}`
          );
        trace.push(plan.key);
        let remaining = plan.source;
        let done = true;
        for (const step of plan.steps) {
          const going = () => {
            const alternatives = choices(mind, undefined, new Set(), places, remaining);
            const current = alternatives.find((p) => p.id === plan.id)?.rate ?? plan.rate;
            const other = alternatives[0];
            return !other || other.id === plan.id || other.rate - current <= mind.temper.patience * Math.abs(current);
          };
          if (!(await hands.do(step, going))) {
            if ((await going()) && step.verb !== 'learn-spell')
              throw new Error(`${skill} refused ${plan.key}: ${JSON.stringify(step)}`);
            done = false;
            break;
          }
          remaining = advance(remaining);
        }
        if (plan.key.startsWith('practise')) attempts++;
        mind.complete(plan.id, done);
      }
      expect(shard.purchases.length).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(0);
      expect(shard.crafts.length + shard.casts.length).toBeGreaterThanOrEqual(3);
      expect(mind.skill(skill)).toBeGreaterThan(skill === 'Magery' || skill === 'Necromancy' ? 30 : 20);
      expect(mind.care.trainingSpent()).toBeGreaterThan(0);
      if (['Tinkering', 'Carpentry', 'Inscribe'].includes(skill))
        expect(shard.state().toolsBroken).toBeGreaterThanOrEqual(3);
      const replay = new Mind('pupil', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining'], [skill]);
      for (const e of events) replay.observe(e as never);
      expect(replay.care.trainingSpent()).toBe(mind.care.trainingSpent());
      expect([...replay.care.knownSpells]).toEqual([...mind.care.knownSpells]);
    } finally {
      stop();
    }
  }, 60_000);
}
