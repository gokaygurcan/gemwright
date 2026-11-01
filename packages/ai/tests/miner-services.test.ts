import { expect, test } from 'bun:test';

import { board, logPile } from '@gemwright/common/game/items';

import { banked } from '../src/miner-services';

test("a miner's bank trip takes the side trade's boards and logs out of the pack", () => {
  expect(banked(board)).toBe(true);
  expect(banked(logPile)).toBe(true);
});
