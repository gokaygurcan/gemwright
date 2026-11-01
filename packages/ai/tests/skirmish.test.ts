import { expect, test } from 'bun:test';

import { scrapTurn } from '../src/skirmish';
import { behaviorFixture } from './behavior-fixture';

test('a resident with nothing, bare-handed and unskilled, finds a ground with creatures it can beat', async () => {
  const f = behaviorFixture('fisherman');
  f.world.position = { x: 2900, y: 800, z: 0, direction: 2 };
  const phases: string[] = [];
  await scrapTurn({
    ...f.ctx,
    serial: 1,
    status: () => ({ hits: 100, maxHits: 100 }),
    backpack: () => 10,
    phase: (phase) => phases.push(phase)
  });
  expect(phases).toContain('scrapping');
});
