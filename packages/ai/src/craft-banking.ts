import { offersBank, openBankBox } from './bank-gold';
import type { CraftContext } from './craft-training';
import { pickLocation } from './locations';
import { distance } from './navigation';

// Deposits kept exceptional pieces with the town's banker.
export async function bankKept(ctx: CraftContext, backpack: number) {
  const { session } = ctx;
  const kept = ctx.carried(backpack).filter((item) => ctx.checkpoint.keep?.includes(item.serial));
  if (!kept.length) return;
  const bank = pickLocation(ctx.city, 'banker');
  if (!bank) return;
  ctx.phase('bank-keep', `Banking ${kept.length} exceptional piece${kept.length > 1 ? 's' : ''}`);
  await ctx.navigate(bank, 4);
  for (const mobile of session.world.entities.values()) {
    if (!mobile.position || distance(ctx.position(), mobile.position) > 12) continue;
    if (!(await offersBank(session, mobile.serial))) continue;
    const box = await openBankBox(ctx, mobile.serial);
    for (const item of kept) {
      ctx.check();
      await session.moveItem(item.serial, box);
      ctx.checkpoint.keep = ctx.checkpoint.keep?.filter((serial) => serial !== item.serial);
      await Bun.sleep(700);
    }
    return;
  }
}
