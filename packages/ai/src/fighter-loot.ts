import { gold } from '@gemwright/common/items';

import { type FighterContext, huntable, valuable } from './fighter-context';
import { packFull } from './inventory';
import { lootPriority, observedAmount, recordIncome } from './loot-economy';
import { distance } from './navigation';

// Loots a defeated opponent's corpse: valuables and anything the shard flags as wearable or
// stackable, until the pack is full; better armor is put on when nothing is close.
export function createCorpseLooter(ctx: FighterContext, dress: () => Promise<void>) {
  const { session, navigate, contents, terrain, check, trip, persist, stats, nearby, position, log } = ctx;
  // Every corpse left behind says why in the log, so a kill that brings nothing can be traced.
  return async (corpse: number | undefined) => {
    if (corpse === undefined) {
      log('Loot: the kill was not confirmed by the server (no death seen); no corpse to open');
      return;
    }
    const body = session.world.entities.get(corpse);
    if (!body?.position || body.graphic !== 0x2006) {
      log(
        `Loot: corpse ${corpse} is not in sight (${body ? `graphic 0x${body.graphic.toString(16)}` : 'not observed'})`
      );
      return;
    }
    const at = body.position;
    await navigate(at, 1);
    const before = session.world.received.get(0x3c) ?? 0;
    const last = session.world.journal.at(-1);
    const since = () =>
      last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal;
    // Corpse.CheckLoot denies a shared kill (1005035) without contents.
    const denied = () => since().some((entry) => entry.cliloc === 1005035);
    // The shard answers an out-of-range double-click with 500446 ("too far away") and no contents.
    const tooFar = () => since().some((entry) => entry.cliloc === 500446);
    const lookInside = async () => {
      if (distance(position(), at) > 1) await navigate(at, 0).catch(() => {});
      session.use(corpse);
      await session.waitFor(
        () => (session.world.received.get(0x3c) ?? 0) > before || denied() || tooFar(),
        'container contents',
        4000
      );
    };
    try {
      await lookInside();
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      // One more look from the corpse's own tile before giving up on it.
      await navigate(at, 0).catch(() => {});
      await lookInside();
    }
    if (tooFar()) {
      log(`corpse ${corpse} stayed out of reach; leaving it`);
      return;
    }
    if (denied()) {
      log(`corpse ${corpse} belongs to another player's kill; leaving it`);
      return;
    }
    const inside = contents(corpse);
    const lootedBefore = stats.looted;
    for (const item of inside.sort((a, b) => lootPriority(b) - lootPriority(a)).slice(0, 40)) {
      if (!valuable(item.graphic) && !(terrain.tile(item.graphic, true).flags & (0x2 | 0x08000000))) continue;
      check();
      const s = session.world.status;
      const mergingGold = item.graphic === gold && observedAmount(session, ctx.backpack(), item) > 0;
      if (packFull(session, ctx.backpack(), 0.85) && !(mergingGold && s && s.weight < s.maxWeight * 0.92)) break;
      const quantity =
        item.graphic === gold && s
          ? Math.min(item.amount ?? 1, Math.max(0, Math.floor((s.maxWeight * 0.92 - s.weight) * 125)))
          : (item.amount ?? 1);
      if (quantity <= 0) continue;
      const before = observedAmount(session, ctx.backpack(), item);
      const beforeStacks = new Map(contents().map((owned) => [owned.serial, owned.amount ?? 1]));
      try {
        await session.moveItem(item.serial, ctx.backpack(), quantity);
      } catch (error) {
        check();
        log(`Loot transfer refused: ${error instanceof Error ? error.message : 'unknown refusal'}`);
        continue;
      }
      const gained = observedAmount(session, ctx.backpack(), item) - before;
      if (gained <= 0) continue;
      if (item.graphic === gold) recordIncome(ctx.checkpoint, 'lootedGold', gained);
      // Merged stacks can have another serial; record the inventory actually received.
      if (![gold, 0x0f3f, 0x1bfb].includes(item.graphic))
        for (const owned of contents().filter((e) => e.graphic === item.graphic && (e.hue ?? 0) === (item.hue ?? 0)))
          if ((owned.amount ?? 1) > (beforeStacks.get(owned.serial) ?? 0) && !trip.loot.includes(owned.serial))
            trip.loot.push(owned.serial);
      stats.looted++;
      persist();
      await Bun.sleep(700);
      await session.refreshStatus();
    }
    if (stats.looted === lootedBefore)
      log(`Loot: took nothing from corpse ${corpse} (${inside.length} items, none worth carrying or room for)`);
    // Wear better looted armor on the spot.
    if (!nearby().some((m) => huntable(m, new Set()) && !!m.position && distance(position(), m.position) < 10))
      await dress();
  };
}
