import { expect, test } from 'bun:test';

import { parseWorkOrder } from '../src/v1/work-orders';

test('a player ordering one bolt is understood', () => {
  expect(parseWorkOrder('Make 1 bolt for 5 gold')).toEqual({ good: 'bolts', amount: 1, price: 5 });
});
