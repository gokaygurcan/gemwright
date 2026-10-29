import { expect, spyOn, test } from 'bun:test';

import { urgentAction } from '../src/action-purpose';
import { checkLoop, Stuck, watchStep } from '../src/loop-watch';
import { chooseGoal, leaseGoal, registerGoal } from '../src/resident-goal';
import { workEvidence } from '../src/work-evidence';
import { behaviorFixture, required } from './behavior-fixture';

test('movement, losses and inventory churn cannot defer the idle guard', () => {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = behaviorFixture();
    watchStep(f.session, 'test', 'walking', 'Going to the shop');
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      required(f.world.position).x += 10;
      required(f.world.entities.get(11)).amount = 1000 - i * 20;
      required(f.world.status).hits = i % 2 ? 50 : 100;
      f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x1bf2, parent: 10, amount: i + 1 });
      checkLoop(f.session);
    }
    now += 6000;
    expect(() => checkLoop(f.session)).toThrow(Stuck);
  } finally {
    clock.mockRestore();
  }
});

test('an expired plan interrupts once, clears its lease, and allows setback recovery', async () => {
  let now = 2_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = behaviorFixture();
    registerGoal(f.session, f.checkpoint);
    const goal = chooseGoal(f.checkpoint, {
      evidence: workEvidence(f.session),
      safe: true,
      ready: true,
      learning: false,
      earningNeeded: false
    });
    leaseGoal(f.session, goal);
    checkLoop(f.session);
    now = goal.stepUntil;
    await urgentAction(f.session, 'escape', async () => {
      expect(() => checkLoop(f.session)).not.toThrow();
    });
    expect(() => checkLoop(f.session)).toThrow(Stuck);
    expect(f.checkpoint.workGoal?.active).toBeUndefined();
    expect(f.checkpoint.workGoal?.last?.result).toBe('blocked');
    watchStep(f.session, 'test', 'setback', 'Choosing another plan');
    expect(() => checkLoop(f.session)).not.toThrow();
  } finally {
    clock.mockRestore();
  }
});
