import { expect, setSystemTime, test } from 'bun:test';

import { absence } from '../src/absence';
import { tuning } from '../src/tuning';

test('something found missing where the world says it may be is left alone a while, longer if missed again soon', () => {
  const now = Date.now();
  const healer = { x: 1480, y: 1610 };
  const missed = absence(7001);
  try {
    setSystemTime(now);
    expect(missed.note('healer', healer)).toBe(tuning.absence.minutes.healer);
    expect(missed.seen('healer', healer)).toBe(true);
    expect(absence(7002).seen('healer', healer)).toBe(false);
    // The spawner brings it back: the mark always runs out.
    setSystemTime(now + tuning.absence.minutes.healer * 60_000 + 1000);
    expect(missed.seen('healer', healer)).toBe(false);
    // Missed again soon after: held longer, and still not for ever.
    const longer = missed.note('healer', healer);
    expect(longer).toBe(tuning.absence.minutes.healer * tuning.absence.repeatFactor);
    setSystemTime(now + (tuning.absence.minutes.healer + longer) * 60_000 + 2000);
    expect(missed.seen('healer', healer)).toBe(false);
  } finally {
    setSystemTime();
  }
});
