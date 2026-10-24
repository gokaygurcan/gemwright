import { gold } from '@gemwright/common/items';

import { distance } from './navigation';
import type { ProfessionContext } from './profession';

// A bard earns from the undead it sets on each other: ServUO credits a provoked kill to the bard
// (BaseCreature.BardMaster), so the corpse opens for it. Only gold is taken, coins it later spends
// on instruments and banks like anyone. A corpse that refuses (1005035, someone else's kill) or
// holds nothing is not tried again.
const CORPSE = 0x2006;
const tried = new WeakMap<ProfessionContext['checkpoint'], Set<number>>();

export async function lootProvoked(ctx: ProfessionContext): Promise<boolean> {
  const { session } = ctx;
  const seen = tried.get(ctx.checkpoint) ?? new Set<number>();
  tried.set(ctx.checkpoint, seen);
  const corpse = [...session.world.entities.values()].find(
    (item) =>
      item.kind === 'item' &&
      item.graphic === CORPSE &&
      item.position &&
      !seen.has(item.serial) &&
      distance(ctx.position(), item.position) <= 10
  );
  if (!corpse?.position) return false;
  seen.add(corpse.serial);
  if (seen.size > 200) seen.delete(seen.values().next().value as number);
  ctx.phase('bard-loot', 'Collecting the coins of the undead I set against each other');
  await ctx.navigate(corpse.position, 1).catch(() => {});
  const before = session.world.received.get(0x3c) ?? 0;
  session.use(corpse.serial);
  await session
    .waitFor(() => (session.world.received.get(0x3c) ?? 0) > before, 'corpse contents', 3000)
    .catch(() => {});
  let taken = 0;
  for (const coins of session.world.childrenOf(corpse.serial).filter((item) => item.graphic === gold)) {
    await session
      .moveItem(coins.serial, ctx.backpack())
      .then(() => {
        taken += coins.amount ?? 1;
      })
      .catch(() => {});
    await Bun.sleep(400);
  }
  if (taken) ctx.log(`Took ${taken} gold from a provoked kill`);
  return taken > 0;
}
