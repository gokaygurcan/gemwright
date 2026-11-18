import { expect, test } from 'bun:test';

import { onItem, useOn } from '../src/target-action';
import { behaviorFixture } from './behavior-fixture';

test('using a tool on something says why it did not happen: our own cursor, the shard refusing, or no cursor', async () => {
  const { session, world } = behaviorFixture();
  const aimed: unknown[] = [];
  session.waitFor = async (ready) => {
    if (!ready()) throw new Error('timeout');
  };
  session.target = (aim) => {
    aimed.push(aim);
    world.target = null;
  };
  const cursor = { serial: 1, kind: 0 } as unknown as NonNullable<typeof world.target>;
  const pile = { serial: 40, graphic: 0x1bdd };
  world.target = cursor;
  expect(await useOn(session, () => {}, onItem(pile), { label: 'cursor' })).toEqual({ why: 'cursor-busy' });
  world.target = null;
  const worn = () => world.addJournal({ serial: 0, name: 'System', cliloc: 1044038, arguments: '' });
  expect(await useOn(session, worn, onItem(pile), { label: 'cursor', refusals: [1044038] })).toEqual({
    why: 'refused',
    cliloc: 1044038
  });
  expect(await useOn(session, () => {}, onItem(pile), { label: 'cursor' })).toEqual({ why: 'no-cursor' });
  expect(
    await useOn(
      session,
      () => {
        world.target = cursor;
      },
      onItem(pile),
      { label: 'cursor' }
    )
  ).toEqual({ ok: true });
  expect(aimed).toEqual([{ serial: 40, x: 0, y: 0, z: 0, graphic: 0x1bdd }]);
});
