import { TileFlag } from '@gemwright/common/assets/tiledata';
import { gold } from '@gemwright/common/game/items';
import { Notoriety } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { offersBank, openBankBox, queryBankBalance } from './bank-gold';
import { nearAnyGround, travelNear } from './cemeteries';
import { replaceDeathRobe } from './death-robe';
import { actionScope } from './execution-session';
import { bandage, type FighterContext, healPotion } from './fighter-context';
import { createFighterRestock, fighterSupplyName } from './fighter-supplies';
import { packItems } from './inventory';
import { learnQuality, shopSafe } from './item-quality';
import { allServiceLocations } from './locations';
import { forcedToWork } from './loop-watch';
import { recordIncome } from './loot-economy';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { errand } from './objective-memory';
import { travelScrolls } from './scribe';
import { shopsFor } from './selling';
import { createServiceExperience } from './service-experience';

export function createFighterTown(ctx: FighterContext, heal: () => Promise<void>) {
  const {
    session,
    terrain,
    position,
    status,
    contents,
    nearby,
    check,
    phase,
    navigate,
    deadline,
    trip,
    persist,
    log,
    stats,
    checkpoint
  } = ctx;
  const learning = createServiceExperience(ctx);
  // Bankers answer the "bank" keyword from across the bank floor; no walk to the counter.
  const openBank = async (mobile: Entity, retry = false) => {
    if ((!retry && learning.blocked(mobile, Actions.bank)) || !(await offersBank(session, mobile.serial))) return;
    try {
      return await openBankBox(ctx, mobile.serial);
    } catch (error) {
      check();
      learning.record(mobile, Actions.bank, 'unavailable');
      log(`Banker unavailable: ${error instanceof Error ? error.message : error}`);
    }
  };
  const contextAction = async (mobile: Entity, cliloc: number, needs: readonly number[] = []) => {
    if (mobile.notoriety !== Notoriety.invulnerable) return false;
    if (learning.blocked(mobile, cliloc, needs)) return false;
    try {
      const entry = (await session.context(mobile.serial)).find((entry) => entry.cliloc === cliloc);
      if (!entry) {
        learning.record(mobile, cliloc, 'no-service');
        return false;
      }
      if (!mobile.position) return false;
      await approachVendor(ctx, mobile.serial);
      const current = (await session.context(mobile.serial)).find(
        (entry) => entry.cliloc === cliloc && !(entry.flags & 1)
      );
      if (!current) return false;
      session.selectContext(mobile.serial, current.index);
      return true;
    } catch (error) {
      check();
      learning.record(
        mobile,
        cliloc,
        error instanceof Error && /route|approach|blocked/i.test(error.message) ? 'unreachable' : 'unavailable'
      );
      log(
        `Vendor unavailable${needs.length ? ` for ${needs.map((graphic) => fighterSupplyName(ctx, graphic)).join(', ')}` : ''}: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
  };
  const restock = createFighterRestock(ctx, contextAction, learning);
  const sellLoot = async () => {
    if (forcedToWork(session)) return;
    phase('selling', 'Offering recorded loot to vendors who actually buy those items');
    // The same mapping the resident trades sell by decides the shops: whatever a shop buys decides
    // where the fighter walks (a looted fish steak goes to a fishmonger, not to the blacksmith).
    const services = new Set(
      contents()
        .filter((item) => trip.loot.includes(item.serial) && item.graphic !== gold)
        .flatMap((item) => shopsFor(ctx, item))
    );
    if (
      contents().some(
        (item) =>
          trip.loot.includes(item.serial) &&
          (terrain.tile(item.graphic, true).flags & (TileFlag.Weapon | TileFlag.Armor) ||
            (item.graphic >= 0x144e && item.graphic <= 0x1457))
      )
    )
      services.add('blacksmith');
    if (contents().some((item) => trip.loot.includes(item.serial) && item.graphic >= 0xf10 && item.graphic <= 0xf30))
      services.add('jeweler');
    if (contents().some((item) => trip.loot.includes(item.serial) && item.graphic >= 0x1f2d && item.graphic <= 0x1f6c))
      services.add('mage');
    const saleStops = [...services]
      .map((service) => ctx.home.one(service))
      .filter((shop): shop is NonNullable<typeof shop> => !!shop);
    // Magic, blessed, artifact and exceptional loot is kept, never sold at base price (item-quality.ts).
    await learnQuality(
      session,
      contents().filter((item) => trip.loot.includes(item.serial))
    );
    for (const shop of saleStops) {
      if (!contents().some((item) => trip.loot.includes(item.serial) && item.graphic !== gold)) break;
      // The shop may be across water (Britain's for an island town): travelNear takes the moongate.
      await errand(ctx, `sell:${shop.x},${shop.y}`, `selling at ${shop.x},${shop.y}`, async () => {
        await travelNear(ctx, shop, 5);
        for (const mobile of learning.order(nearby(), Actions.sell)) {
          session.world.sellOffers.delete(mobile.serial);
          if (!(await contextAction(mobile, Actions.sell))) continue;
          try {
            await session.waitFor(() => session.world.sellOffers.has(mobile.serial), 'vendor buying list', 2200);
          } catch {
            check();
            continue;
          }
          const offers = session.world.sellOffers.get(mobile.serial) ?? [];
          const sale = offers
            .filter(
              (item) =>
                item.price > 0 &&
                trip.loot.includes(item.serial) &&
                contents().some(
                  (owned) =>
                    owned.serial === item.serial &&
                    owned.graphic !== gold &&
                    shopSafe(owned) &&
                    // Travel scrolls are worth more to residents than to the mage (scribe.ts).
                    !travelScrolls.has(owned.graphic) &&
                    ![bandage, healPotion].includes(owned.graphic)
                )
            )
            .slice(0, 99);
          if (!sale.length) continue;
          await approachVendor(ctx, mobile.serial);
          const coinsBefore = contents()
            .filter((item) => item.graphic === gold)
            .reduce((n, item) => n + (item.amount ?? 1), 0);
          const stockBefore = new Map(contents().map((item) => [item.serial, item.amount ?? 1]));
          await session.sell(
            mobile.serial,
            sale.map((item) => ({ serial: item.serial, amount: item.amount }))
          );
          const coinsAfter = contents()
            .filter((item) => item.graphic === gold)
            .reduce((n, item) => n + (item.amount ?? 1), 0);
          const sold = sale.filter(
            (item) =>
              (contents().find((owned) => owned.serial === item.serial)?.amount ?? 0) <
              (stockBefore.get(item.serial) ?? 0)
          );
          if (!sold.length || coinsAfter <= coinsBefore) continue;
          recordIncome(checkpoint, 'soldGold', coinsAfter - coinsBefore);
          learning.record(mobile, Actions.sell, 'success');
          stats.sold += sold.length;
          trip.loot = trip.loot.filter((id) => contents().some((item) => item.serial === id));
          persist();
          await session.refreshStatus();
          log(`Sold ${sale.length} loot items; gold ${status().gold}`);
          await Bun.sleep(700);
        }
      });
    }
  };
  // A bank trip that deposits or learns nothing is not made again for two hours.
  const bank = async () => {
    if (forcedToWork(session)) return;
    await errand(ctx, 'bank', 'a bank trip', async () => {
      // A fighter whose corpse was lost still wears the death robe: new clothes once it can pay.
      await replaceDeathRobe({
        ...ctx,
        city: ctx.home.city,
        carried: (pack: number) => session.world.childrenOf(pack)
      });
      phase('banking', 'Banking profits and unsold valuables; vendors can charge the bank directly');
      // The home town's banks, then the nearest others; a banker remembered as unavailable is tried
      // again on the second pass rather than leaving the gold unbanked.
      const others = allServiceLocations('banker')
        .filter((b) => !ctx.home.banks.some((h) => h.x === b.x && h.y === b.y))
        .sort((a, b) => distance(position(), a) - distance(position(), b))
        .slice(0, 2);
      for (const [pass, location] of [
        ...ctx.home.banks.map((l) => [0, l] as const),
        ...others.map((l) => [1, l] as const)
      ]) {
        await navigate(location, 4);
        const bankers = learning.order(nearby(), Actions.bank);
        if (!bankers.length) log(`No vendor in view at the bank near ${location.x},${location.y}`);
        for (const mobile of bankers) {
          const opened = await openBank(mobile, pass > 0);
          if (opened === undefined) continue;
          const box = { serial: opened };
          await Bun.sleep(500);
          for (const item of contents()) {
            check();
            if (item.graphic === gold) {
              const deposit = item.amount ?? 1;
              if (deposit <= 0) continue;
              await session.moveItem(item.serial, box.serial, deposit);
              stats.bankedGold += deposit;
              recordIncome(checkpoint, 'bankedGold', deposit);
            } else if (trip.loot.includes(item.serial) && packItems(session, box.serial).length < 100) {
              // The bank box holds 125 items; past 100 unsold loot stays out of it (inventory.ts).
              await session.moveItem(item.serial, box.serial);
              stats.bankedItems++;
            } else continue;
            trip.loot = trip.loot.filter((id) => id !== item.serial);
            persist();
            await Bun.sleep(700);
          }
          trip.loot = trip.loot.filter((id) => contents().some((item) => item.serial === id));
          learning.record(mobile, Actions.bank, 'success');
          await queryBankBalance(ctx, mobile.serial);
          trip.killsSinceBank = 0;
          trip.pending = 'hunt';
          delete trip.encounter;
          persist();
          await session.refreshStatus();
          log(
            `Bank confirmed: ${stats.bankedGold} gold and ${stats.bankedItems} valuables deposited this run; bank balance ${checkpoint.funds?.bank ?? 'unknown'}`
          );
          return;
        }
      }
      throw new Error('No observed banker offered access');
    });
  };
  // One bounded recovery action: at most a minute and a half of healing per invocation, then the
  // goal layer paces the retry (goal-turn.ts) and its deadline bounds the whole recovery.
  const rest = () =>
    actionScope(
      session,
      'recovery',
      'Recover to working health',
      async () => {
        if (status().hits < status().maxHits * 0.9 && nearAnyGround(position())) await navigate(ctx.home.town, 4);
        phase('recovering-health', 'Recovering in town before another fight');
        const until = Math.min(deadline, Date.now() + 90_000);
        while ((status().hits < status().maxHits * 0.9 || (session.world.poisonLevel ?? 0) > 0) && Date.now() < until) {
          check();
          await heal();
          await Bun.sleep(2500);
          await session.refreshStatus();
        }
      },
      135_000
    );
  return { contextAction, openBank, restock, sellLoot, bank, rest };
}
