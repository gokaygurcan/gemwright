import { expect, test } from 'bun:test';

import { LoopBreaker } from '../src/v2/loop-breaker';

test('three refusals exclude a course while alternatives remain eligible', () => {
  const guard = new LoopBreaker(0);
  for (let i = 0; i < 3; i++) guard.finish('equip boots', false, false, i);
  expect(guard.allows('equip boots', 3)).toBe(false);
  expect(guard.allows('mine', 3)).toBe(true);
  expect(guard.allows('equip boots', 300_003)).toBe(true);
});

test('completed plans with no useful outcome also trip the breaker', () => {
  const guard = new LoopBreaker(0);
  for (let i = 0; i < 6; i++) guard.finish('empty trade', true, false, i);
  expect(guard.allows('empty trade', 6)).toBe(false);
});

test('alternating unsuccessful courses cannot evade the overall progress limit', () => {
  const guard = new LoopBreaker(0);
  for (let i = 0; i < 12; i++) guard.finish(`course ${i % 2}`, true, false, i);
  expect(guard.stalled(12)).toBe(true);
  const timed = new LoopBreaker(0);
  expect(timed.stalled(120_000)).toBe(true);
});

test('real progress resets unsuccessful attempts but moving alone does not', () => {
  const guard = new LoopBreaker(0);
  for (let i = 0; i < 5; i++) guard.finish('work', true, false, i);
  guard.finish('work', true, true, 110_000);
  expect(guard.stalled(120_000)).toBe(false);
  expect(guard.allows('work', 120_000)).toBe(true);
  guard.relocated(120_000);
  expect(guard.stalled(240_000)).toBe(true);
});
