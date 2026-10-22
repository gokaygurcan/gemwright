import { type FighterContext, huntable, valuable } from './fighter-context';
import { distance } from './navigation';

// Loots a defeated opponent's corpse: valuables and anything the shard flags as wearable or
// stackable, up to the template's bank weight; better armor is put on when nothing is close.
export function createCorpseLooter(ctx: FighterContext, dress: () => Promise<void>) {
  const { session, navigate, contents, terrain, check, status, template, trip, persist, stats, nearby, position, log } =
    ctx;
  return async (corpse: number) => {
    const body = session.world.entities.get(corpse);
    if (!body?.position || body.graphic !== 0x2006) return;
    await navigate(body.position, 1);
    const before = session.world.received.get(0x3c) ?? 0;
    const last = session.world.journal.at(-1);
    // Corpse.CheckLoot denies a shared kill (1005035) without contents.
    const denied = () =>
      (last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal).some(
        (entry) => entry.cliloc === 1005035
      );
    session.use(corpse);
    await session.waitFor(
      () => (session.world.received.get(0x3c) ?? 0) > before || denied(),
      'container contents',
      4000
    );
    if (denied()) {
      log(`corpse ${corpse} belongs to another player's kill; leaving it`);
      return;
    }
    for (const item of contents(corpse)) {
      if (!valuable(item.graphic) && !(terrain.tile(item.graphic, true).flags & (0x2 | 0x08000000))) continue;
      check();
      if (status().weight > status().maxWeight * template.behavior.bankAtWeightRatio) break;
      // Recovered ammunition is kit, not merchandise.
      if (![0x0f3f, 0x1bfb].includes(item.graphic)) trip.loot.push(item.serial);
      persist();
      await session.moveItem(item.serial, ctx.backpack());
      stats.looted++;
      persist();
      await Bun.sleep(700);
      await session.refreshStatus();
    }
    // Wear better looted armor on the spot.
    if (!nearby().some((m) => huntable(m, new Set()) && !!m.position && distance(position(), m.position) < 10))
      await dress();
  };
}
