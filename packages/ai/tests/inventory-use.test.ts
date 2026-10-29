import { expect, test } from 'bun:test';

import { eatMagicFish } from '../src/inventory-use';
import { behaviorFixture } from './behavior-fixture';

// ServUO's magic fish (MagicFish.cs, 0x0DD6 in four hues) are eaten whole for their blessing; no
// shop buys one, so a carried fish is eaten at the next pause rather than carried for ever.
test('a magic fish is eaten at the next pause, and not asked for again for a while', () => {
  const { session, world } = behaviorFixture();
  world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x0dd6, parent: 10, hue: 86 });
  expect(eatMagicFish(session)).toBe(true);
  // The fixture's shard keeps the fish (no effect applied): the resident waits before asking again.
  expect(eatMagicFish(session)).toBe(false);
});

test('no magic fish, nothing eaten', () => {
  const { session } = behaviorFixture();
  expect(eatMagicFish(session)).toBe(false);
});
