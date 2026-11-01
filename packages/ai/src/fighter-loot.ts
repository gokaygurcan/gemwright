import { TileFlag } from '@gemwright/common/assets/tiledata';
import { HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { arrow, crossbowBolt, gold } from '@gemwright/common/game/items';

import { type Death, openCorpse } from './corpse-open';
import { type FighterContext, huntable, valuable } from './fighter-context';
import { packFull } from './inventory';
import { quality } from './item-quality';
import { lootPriority, observedAmount, recordIncome } from './loot-economy';
import { distance } from './navigation';

// Loots a defeated opponent's corpse: gold and gems first, then valuables and anything the shard
// flags as wearable or stackable, until the pack is full; better armor is put on when nothing is
// close. Gold is taken even when the pack is otherwise full (a few coins weigh almost nothing), and
// a death whose corpse serial arrived as 0 is found by looking for a fresh corpse where it fell.
export function createCorpseLooter(ctx: FighterContext, dress: () => Promise<void>) {
  const { session, contents, terrain, check, trip, persist, stats, nearby, position, log } = ctx;
  // Corpses already emptied this run, so the fallback search does not open the same one twice.
  const emptied = new Set<number>();
  // Heavy pieces — armour and shields/weapons — are worth the stones only when the slot is bare or
  // the piece is worth more than scrap: a fighter does not haul bone armour off every skeleton, fill
  // its pack with it and walk to town for the privilege. Coins and light things always come.
  const heavy = (graphic: number) =>
    (graphic >= 0x144e && graphic <= 0x1457) || (graphic >= 0x1b72 && graphic <= 0x1b7b);

  // Every corpse left behind says why in the log, so a kill that brings nothing can be traced.
  return async (death?: Death) => {
    const opened = await openCorpse(ctx, death, emptied);
    if ('why' in opened) {
      log(
        opened.why === 'not-found'
          ? `Loot: no corpse in sight for this death (serial ${death?.corpse ?? 'none'}; ${
              death?.position ? `fell at ${death.position.x},${death.position.y}` : 'no death position'
            })`
          : `Loot: corpse ${death?.corpse ?? '?'} ${opened.why === 'denied' ? "belongs to another player's kill" : 'stayed out of reach'}; leaving it`
      );
      return;
    }
    const { corpse } = opened;
    emptied.add(corpse);
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
      if (!valuable(item.graphic) && !(terrain.tile(item.graphic, true).flags & (TileFlag.Weapon | TileFlag.Armor)))
        continue;
      if (heavy(item.graphic)) {
        const worn = session.world.childrenOf(ctx.serial).some((piece) => piece.layer === item.layer);
        if (worn && quality(item) === 'normal') continue;
      }
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
      if (![gold, arrow, crossbowBolt].includes(item.graphic))
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

// Whatever else attacked it and fell in the same fight is its kill too: deaths since `before`, near
// it, that are not people.
export const fellAlongside = (ctx: FighterContext, before: Set<number>, defeated: number) =>
  [...ctx.session.world.deaths].flatMap(([killed, death]) =>
    !before.has(killed) &&
    killed !== defeated &&
    death.position &&
    distance(ctx.position(), death.position) <= 6 &&
    !HUMAN_ELF_BODIES.has(ctx.session.world.entities.get(killed)?.graphic ?? 0)
      ? [death]
      : []
  );
