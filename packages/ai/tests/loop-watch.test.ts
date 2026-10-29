import { expect, spyOn, test } from 'bun:test';

import { urgentAction } from '../src/action-purpose';
import { checkLoop, forcedToWork, noteNavigationStep, Stuck, watchStep } from '../src/loop-watch';
import { tally } from '../src/work-evidence';
import { behaviorFixture, required } from './behavior-fixture';

function withClock(run: (advance: (ms: number) => void) => Promise<void> | void) {
  let now = 5000000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  return Promise.resolve()
    .then(() =>
      run((ms) => {
        now += ms;
      })
    )
    .finally(() => clock.mockRestore());
}

test('repeated multi-step cycles normalize coordinates, interrupt once and force a changed plan', () =>
  withClock(() => {
    const f = behaviorFixture();
    for (let cycle = 0; cycle < 3; cycle++) {
      watchStep(f.session, 'test', 'travel', `Walking to ${100 + cycle},200`);
      watchStep(f.session, 'test', 'return', `Returning from ${300 + cycle},400`);
    }
    expect(forcedToWork(f.session)).toBe(true);
    expect(() => checkLoop(f.session)).toThrow(Stuck);
    expect(() => checkLoop(f.session)).not.toThrow();
    const other = behaviorFixture();
    expect(() => checkLoop(other.session)).not.toThrow();
    expect(forcedToWork(other.session)).toBe(false);
  }));

test('verified production breaks a repetition sequence; changing possession counts does not', () =>
  withClock(() => {
    const f = behaviorFixture();
    for (let cycle = 0; cycle < 2; cycle++) {
      watchStep(f.session, 'test', 'go', 'Going');
      watchStep(f.session, 'test', 'back', 'Returning');
    }
    tally(f.session, 'mined');
    watchStep(f.session, 'test', 'go', 'Going');
    watchStep(f.session, 'test', 'back', 'Returning');
    expect(() => checkLoop(f.session)).not.toThrow();
    for (let cycle = 0; cycle < 3; cycle++) {
      const coins = required(f.world.entities.get(11));
      coins.amount = (coins.amount ?? 1) - 1;
      watchStep(f.session, 'test', 'go', 'Going');
      watchStep(f.session, 'test', 'back', 'Returning');
    }
    expect(() => checkLoop(f.session)).toThrow(Stuck);
  }));

test('single repeated steps require both count and time, and never count an active trade as a loop', () =>
  withClock((advance) => {
    const f = behaviorFixture();
    for (let i = 0; i < 12; i++) watchStep(f.session, 'test', 'waiting', 'Trying the same vendor');
    expect(() => checkLoop(f.session)).not.toThrow();
    advance(61000);
    watchStep(f.session, 'test', 'waiting', 'Trying the same vendor');
    expect(() => checkLoop(f.session)).toThrow(Stuck);
    const trading = behaviorFixture();
    trading.world.trade = {
      partner: 2,
      mine: 20,
      theirs: 21,
      name: 'Player',
      closed: false,
      accepted: { me: false, them: false }
    };
    watchStep(trading.session, 'test', 'trade', 'Waiting for the player');
    advance(61000);
    for (let i = 0; i < 20; i++) watchStep(trading.session, 'test', 'trade', 'Waiting for the player');
    for (let i = 0; i < 3; i++) {
      watchStep(trading.session, 'test', 'offer', 'Considering an offer');
      watchStep(trading.session, 'test', 'trade', 'Waiting for the player');
    }
    expect(forcedToWork(trading.session)).toBe(false);
  }));

test('bounded recovery phases are paced by the goal deadline instead of the loop guard', () =>
  withClock((advance) => {
    const f = behaviorFixture();
    for (let i = 0; i < 30; i++) {
      watchStep(
        f.session,
        'test',
        i % 2 ? 'recovery-wait' : 'recovering',
        'Getting safely back to working health before resuming the plan (100/100 hp)'
      );
      advance(1000);
    }
    expect(forcedToWork(f.session)).toBe(false);
    expect(() => checkLoop(f.session)).not.toThrow();
    for (let i = 0; i < 40; i++) {
      watchStep(f.session, 'test', 'recovering-health', 'Recovering in town before another fight');
      advance(10_000);
      checkLoop(f.session);
    }
    expect(forcedToWork(f.session)).toBe(false);
    expect(() => checkLoop(f.session)).not.toThrow();
    // Leaving recovery hands the idle clock back to the guard.
    advance(5 * 60_000 + 1000);
    watchStep(f.session, 'test', 'walking', 'Going to the shop');
    expect(() => checkLoop(f.session)).toThrow(Stuck);
  }));

test('small-area circling across navigation calls interrupts; travel and safety movement remain possible', () =>
  withClock(async (advance) => {
    const f = behaviorFixture();
    watchStep(f.session, 'test', 'travel', 'Walking');
    advance(90001);
    for (let i = 0; i < 20; i++) {
      required(f.world.position).x = 100 + (i % 3);
      advance(1000);
      noteNavigationStep(f.session);
    }
    expect(() => checkLoop(f.session)).toThrow(Stuck);
    const traveling = behaviorFixture();
    watchStep(traveling.session, 'test', 'travel', 'Walking');
    advance(90001);
    for (let i = 0; i < 20; i++) {
      required(traveling.world.position).x += 2;
      advance(1000);
      noteNavigationStep(traveling.session);
    }
    expect(() => checkLoop(traveling.session)).not.toThrow();
    const escaping = behaviorFixture();
    watchStep(escaping.session, 'test', 'escape', 'Avoiding danger');
    advance(90001);
    await urgentAction(escaping.session, 'escape', async () => {
      for (let i = 0; i < 25; i++) {
        advance(1000);
        noteNavigationStep(escaping.session);
      }
      expect(() => checkLoop(escaping.session)).not.toThrow();
    });
    expect(forcedToWork(escaping.session)).toBe(false);
  }));
