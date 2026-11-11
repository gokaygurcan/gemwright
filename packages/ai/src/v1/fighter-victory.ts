import type { Death } from './corpse-open';
import type { FighterContext } from './fighter-context';
import { tally } from './work-evidence';

export function createKillCollection(ctx: FighterContext, loot: (death?: Death) => Promise<boolean>) {
  const recorded = new Set<number>();
  const remember = (death: Death) => {
    ctx.trip.pendingLoot ??= [];
    if (
      ctx.trip.pendingLoot.some(
        (entry) =>
          entry.corpse === death.corpse &&
          entry.position?.x === death.position?.x &&
          entry.position?.y === death.position?.y
      )
    )
      return;
    ctx.trip.pendingLoot.push({ ...death, position: death.position && { ...death.position } });
    ctx.persist();
  };
  return {
    remember,
    record(serial: number) {
      const death = ctx.session.world.deaths.get(serial);
      if (!death || recorded.has(serial)) return;
      recorded.add(serial);
      remember(death);
      ctx.stats.kills++;
      ctx.trip.killsSinceBank++;
      tally(ctx.session, 'kills');
      ctx.persist();
      ctx.log(`Kill ${serial} confirmed; corpse ${death.corpse} queued for collection`);
    },
    async collect() {
      while (ctx.trip.pendingLoot?.length && !ctx.dead()) {
        const death = ctx.trip.pendingLoot[0];
        if (!death) break;
        const completed = await loot(death);
        if (!completed) {
          ctx.trip.pending = 'return';
          ctx.persist();
          return;
        }
        ctx.trip.pendingLoot.shift();
        ctx.persist();
      }
    }
  };
}
