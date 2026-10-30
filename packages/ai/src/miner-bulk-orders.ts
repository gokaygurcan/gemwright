import { skillId } from '@gemwright/common/game/skills';

import { bulkOrderTurn } from './bulk-orders';
import { blacksmithing } from './miner-crafting';
import type { ProfessionContext } from './profession';

export const carriesBulkOrder = (ctx: Pick<ProfessionContext, 'carried'>) =>
  ctx.carried().some((item) => item.graphic === 0x2258);

export async function minerBulkOrder(
  ctx: ProfessionContext,
  withdraw: (pack: number, least: number, most: number) => Promise<boolean>,
  allowNew = false
): Promise<boolean> {
  const existing = carriesBulkOrder(ctx);
  const smith = ctx.session.world.skills.get(skillId('Blacksmith'))?.base ?? 0;
  if (!existing && (!allowNew || smith < 50 || Math.random() >= 0.3)) return false;
  if (
    existing &&
    (ctx.checkpoint.bulkOrders?.stalledUntil ?? 0) > Date.now() &&
    ctx.checkpoint.bulkOrders?.stalledReason &&
    ctx.checkpoint.bulkOrders.stalledReason !== 'materials'
  )
    return false;
  try {
    return await bulkOrderTurn(
      { ...ctx, refill: (pack, least) => withdraw(pack, least, least * 2) },
      blacksmithing,
      smith
    );
  } catch (error) {
    ctx.check();
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log(`Bulk-order work interrupted: ${reason}`);
    ctx.checkpoint.bulkOrders = {
      nextAt: 0,
      ...ctx.checkpoint.bulkOrders,
      stalledUntil: Date.now() + 2 * 60_000,
      stalledReason: reason
    };
    ctx.persist();
    return false;
  }
}
