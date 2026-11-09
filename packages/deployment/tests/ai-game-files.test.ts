import { expect, test } from 'bun:test';

import { mapPattern } from '../src/ai-deploy';

test('AI asset uploads include house component definitions for both client formats', () => {
  for (const name of ['MultiCollection.uop', 'multi.idx', 'multi.mul', 'tiledata.mul', 'map1LegacyMUL.uop'])
    expect(mapPattern.test(name)).toBe(true);
  expect(mapPattern.test('accounts.xml')).toBe(false);
});
