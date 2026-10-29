import { carriedGold } from './bank-gold';
import { Blocked } from './blocked';
import { lasting } from './lasting';
import { serviceLocations, townAt } from './locations';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';

// No viable work is a recovery state, not a reason to stay where the last task failed.
export async function recoverBlockedWork(ctx: ProfessionContext) {
  const retry = lasting('blocked-work-recovery', ctx.serial);
  if (retry.active('next')) return;
  retry.set('next', Date.now() + 60_000);
  const banks = [...serviceLocations(townAt(ctx.position(), ctx.city), 'banker')].sort(
    (a, b) => distance(ctx.position(), a) - distance(ctx.position(), b)
  );
  for (const bank of banks) {
    if (distance(ctx.position(), bank) <= 6) return;
    ctx.phase('work-recovery', 'No reachable work; returning to town to reassess tools and supplies');
    try {
      await ctx.navigate(bank, 4);
      ctx.log(`Work recovery reached town; carried gold ${carriedGold(ctx.session, ctx.backpack())}`);
      return;
    } catch (error) {
      ctx.check();
      if (!(error instanceof Blocked)) throw error;
      ctx.log(`Work recovery route unavailable: ${error.message}`);
    }
  }
}
