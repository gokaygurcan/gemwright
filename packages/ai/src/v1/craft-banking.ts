import { deposit, openBank } from './bank-box';
import type { CraftContext } from './craft-training';
import { pickLocation } from './locations';

// Deposits kept exceptional pieces with the town's banker.
export async function bankKept(ctx: CraftContext, backpack: number) {
  const kept = ctx.carried(backpack).filter((item) => ctx.checkpoint.keep?.includes(item.serial));
  if (!kept.length) return;
  const bank = pickLocation(ctx.city, 'banker');
  if (!bank) return;
  ctx.phase('bank-keep', `Banking ${kept.length} exceptional piece${kept.length > 1 ? 's' : ''}`);
  await ctx.navigate(bank, 4);
  const box = await openBank(ctx, 12);
  if (!box) return;
  // Only what the bank actually took leaves the list; a refused piece stays kept, with its reason.
  const stored = await deposit(ctx, box, kept);
  ctx.checkpoint.keep = ctx.checkpoint.keep?.filter((serial) => !stored.moved.includes(serial));
  for (const refused of stored.refused) ctx.log(`The bank refused a kept piece: ${refused.reason}`);
}
