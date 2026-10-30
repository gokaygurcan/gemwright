import { Layer } from '@gemwright/network/layers';

import type { FighterContext } from './fighter-context';
import { packItems } from './inventory';

export async function selfLootCorpse(
  ctx: Pick<FighterContext, 'session' | 'serial' | 'backpack' | 'refreshBackpack'>,
  corpse: number
) {
  const owned = () => [
    ...ctx.session.world
      .childrenOf(ctx.serial)
      .filter((item) => item.layer !== Layer.Backpack && item.layer !== Layer.Bank),
    ...packItems(ctx.session, ctx.backpack())
  ];
  const before = new Map(owned().map((item) => [item.serial, item.amount ?? 1]));
  const returned = () =>
    owned().filter((item) => !before.has(item.serial) || (item.amount ?? 1) > (before.get(item.serial) ?? 0));
  // ServUO self-loot restores worn equipment and backpack contents on the owner's double-click.
  ctx.session.use(corpse);
  await ctx.session.waitFor(() => returned().length > 0, 'personal corpse equipment or belongings restored', 3000);
  await ctx.refreshBackpack();
  return returned().length;
}
