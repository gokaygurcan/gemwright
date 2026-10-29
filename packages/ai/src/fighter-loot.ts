import { gold } from '@gemwright/common/items';

import { type FighterContext, huntable, valuable } from './fighter-context';
import { packFull } from './inventory';
import { lootPriority, observedAmount, recordIncome } from './loot-economy';
import { distance } from './navigation';

// Loots a defeated opponent's corpse: gold and gems first, then valuables and anything the shard
// flags as wearable or stackable, until the pack is full; better armor is put on when nothing is
// close. Gold is taken even when the pack is otherwise full (a few coins weigh almost nothing), and
// a death whose corpse serial arrived as 0 is found by looking for a fresh corpse where it fell.
export function createCorpseLooter(ctx: FighterContext, dress: () => Promise<void>) {
  const { session, navigate, contents, terrain, check, trip, persist, stats, nearby, position, log } = ctx;
  // Corpses already emptied this run, so the fallback search does not open the same one twice.
  const emptied = new Set<number>();
  const corpseNear = (at: { x: number; y: number } | undefined) => {
    const here = at ?? position();
    return [...session.world.entities.values()]
      .filter(
        (entity) =>
          entity.kind === 'item' &&
          entity.graphic === 0x2006 &&
          entity.serial !== 0 &&
          !!entity.position &&
          !emptied.has(entity.serial) &&
          distance(here, entity.position) <= 4
      )
      .sort(
        (a, b) =>
          distance(here, a.position as { x: number; y: number }) -
          distance(here, b.position as { x: number; y: number })
      )[0];
  };
  // Every corpse left behind says why in the log, so a kill that brings nothing can be traced.
  return async (death?: { corpse: number; position?: { x: number; y: number; z?: number } }) => {
    const declared = death?.corpse;
    const body =
      declared !== undefined && declared !== 0 && session.world.entities.get(declared)?.graphic === 0x2006
        ? session.world.entities.get(declared)
        : corpseNear(death?.position);
    if (!body?.position) {
      log(
        `Loot: no corpse in sight for this death (serial ${declared ?? 'none'}; ${
          death?.position ? `fell at ${death.position.x},${death.position.y}` : 'no death position'
        })`
      );
      return;
    }
    const corpse = body.serial;
    emptied.add(corpse);
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
    const insideGold = inside
      .filter((item) => item.graphic === gold)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
    if (!inside.length) {
      log(`Loot: corpse ${corpse} opened but holds nothing`);
      return;
    }
    log(`Loot: corpse ${corpse} holds ${inside.length} item(s)${insideGold ? `, ${insideGold} of them gold` : ''}`);
    const lootedBefore = stats.looted;
    let goldGained = 0;
    let refused = 0;
    let noRoom = 0;
    for (const item of inside.sort((a, b) => lootPriority(b) - lootPriority(a)).slice(0, 40)) {
      if (!valuable(item.graphic) && !(terrain.tile(item.graphic, true).flags & (0x2 | 0x08000000))) continue;
      check();
      const mergingGold = item.graphic === gold && observedAmount(session, ctx.backpack(), item) > 0;
      // Coins are worth taking even on a full pack: every coin of the corpse, always (a pile of a
      // hundred weighs under a stone, and the fighter used to take none of it at all).
      if (item.graphic !== gold && packFull(session, ctx.backpack(), 0.85) && !mergingGold) break;
      const quantity = item.amount ?? 1;
      if (quantity <= 0) {
        noRoom++;
        continue;
      }
      const beforeCoins = observedAmount(session, ctx.backpack(), item);
      const beforeStacks = new Map(contents().map((owned) => [owned.serial, owned.amount ?? 1]));
      try {
        await session.moveItem(item.serial, ctx.backpack(), quantity);
      } catch (error) {
        check();
        refused++;
        log(`Loot transfer refused: ${error instanceof Error ? error.message : 'unknown refusal'}`);
        continue;
      }
      const gained = observedAmount(session, ctx.backpack(), item) - beforeCoins;
      if (gained <= 0) {
        noRoom++;
        continue;
      }
      if (item.graphic === gold) {
        goldGained += gained;
        recordIncome(ctx.checkpoint, 'lootedGold', gained);
      }
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
      log(
        `Loot: took nothing from corpse ${corpse} (${inside.length} items` +
          `${goldGained ? `, ${goldGained} gold` : ''}${refused ? `, ${refused} refused` : ''}${noRoom ? `, ${noRoom} no room` : ''})`
      );
    else
      log(
        `Loot: took ${stats.looted - lootedBefore} item(s)` +
          `${goldGained ? ` and ${goldGained} gold` : ''} from corpse ${corpse}` +
          `${refused ? ` (${refused} refused)` : ''}${noRoom ? ` (${noRoom} no room)` : ''}`
      );
    // Wear better looted armor on the spot.
    if (!nearby().some((m) => huntable(m, new Set()) && !!m.position && distance(position(), m.position) < 10))
      await dress();
  };
}
