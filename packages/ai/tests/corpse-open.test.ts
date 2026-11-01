import { expect, test } from 'bun:test';

import { openCorpse } from '../src/corpse-open';
import { behaviorFixture, required } from './behavior-fixture';

test("a death named serial 0 is found where it fell, and another player's kill comes back as the shard's reason", async () => {
  const f = behaviorFixture();
  f.world.entities.set(90, {
    serial: 90,
    kind: 'item',
    graphic: 0x2006,
    position: { x: 102, y: 100, z: 0, direction: 0 }
  });
  f.world.entities.set(91, { serial: 91, kind: 'item', graphic: 0xeed, parent: 90, amount: 12 });
  f.session.waitFor = async (ready) => {
    if (!ready()) throw new Error('timeout');
  };
  f.session.use = () => {
    f.world.received.set(0x3c, (f.world.received.get(0x3c) ?? 0) + 1);
  };
  const opened = await openCorpse(f.ctx, { corpse: 0, position: { x: 102, y: 100 } });
  expect(opened).toEqual({ corpse: 90, items: [required(f.world.entities.get(91))] });
  f.session.use = () => {
    f.world.addJournal({ serial: 0, name: 'System', cliloc: 1005035, arguments: '' });
  };
  expect(await openCorpse(f.ctx, { corpse: 90 })).toEqual({ why: 'denied' });
});
