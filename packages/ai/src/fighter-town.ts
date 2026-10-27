import { gold } from '@gemwright/common/items';

import { chargedPurchase, fundsStale, knownBankGold, offersBank, openBankBox, queryBankBalance } from './bank-gold';
import { nearAnyGround, travelNear } from './cemeteries';
import { replaceDeathRobe } from './death-robe';
import {
  ammoFor,
  bandage,
  curePotion,
  type FighterContext,
  healPotion,
  weaponSkill,
  weaponsFor
} from './fighter-context';
import { poisonPotion, poisons } from './fighter-poison';
import { saving } from './housing';
import { packItems } from './inventory';
import { learnQuality, shopSafe } from './item-quality';
import { allServiceLocations } from './locations';
import { forcedToWork } from './loop-watch';
import { pocketReserve, recordIncome } from './loot-economy';
import { combatReagents } from './mage-combat';
import { buyAtMarket, goodMatch, goods } from './market';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { errand } from './objective-memory';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';
import { travelScrolls } from './scribe';
import { createServiceExperience } from './service-experience';

export function createFighterTown(ctx: FighterContext, heal: () => Promise<void>) {
  const {
    session,
    terrain,
    position,
    status,
    contents,
    count,
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
    if ((!retry && learning.blocked(mobile, 3006105)) || !(await offersBank(session, mobile.serial))) return;
    try {
      return await openBankBox(ctx, mobile.serial);
    } catch (error) {
      check();
      learning.record(mobile, 3006105, 'unavailable');
      log(`Banker unavailable: ${error instanceof Error ? error.message : error}`);
    }
  };
  const contextAction = async (mobile: Entity, cliloc: number, needs: readonly number[] = []) => {
    if (mobile.notoriety !== 7) return false;
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
      log(`Vendor unavailable: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  const casts = () =>
    !!ctx.template.archetype &&
    [...ctx.template.archetype.primarySkills, ...ctx.template.archetype.supportingSkills].includes('Magery');
  // graphic: [restock target, enough to skip a trip, highest unit price]. Archers also stock ammo.
  const supplies = () => {
    const table = new Map([
      [bandage, [30, 20, 8]],
      [healPotion, [4, 3, 60]],
      [curePotion, [3, 2, 60]]
    ]);
    const weapon = [...session.world.entities.values()].find(
      (item) => item.parent === ctx.serial && weaponsFor(ctx.template).has(item.graphic)
    )?.graphic;
    const ammo = weaponSkill(ctx.template) === 'Archery' ? ammoFor(weapon ?? 0x13b2) : undefined;
    if (ammo) table.set(ammo, [150, 50, 4]);
    // Casters keep every reagent their combat spells use (SBMage sells them for 3-5 gold).
    // Casters carry 80-100 of each reagent so they rarely walk back to the mage.
    if (casts()) for (const reagent of combatReagents) table.set(reagent, [90, 30, 7]);
    // Poisoners coat their blade before each fight (fighter-poison.ts); alchemists sell the potions.
    if (poisons(ctx)) table.set(poisonPotion, [10, 3, 40]);
    return table;
  };
  const upgradeBow = async () => {
    const exceptionalBow = goodMatch('exceptional bows');
    const wielded = [...session.world.entities.values()].find(
      (item) => item.parent === ctx.serial && (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded)
    );
    if (wielded) await learnQuality(session, [wielded]);
    // A better bow is a luxury while saving for a house (housing.ts).
    if ((wielded && exceptionalBow(wielded)) || saving(ctx)) return;
    if (!(await buyAtMarket({ ...ctx, city: ctx.home.city }, 'exceptional bows', 1, 3).catch(() => 0))) return;
    await learnQuality(session, contents());
    const bow = contents().find(exceptionalBow);
    if (!bow) return;
    if (wielded) await session.moveItem(wielded.serial, ctx.backpack()).catch(() => {});
    await session.equipItem(bow.serial, ctx.terrain.tile(bow.graphic, true).layer || Layer.TwoHanded).catch(() => {});
    log('Wielding an exceptional bow bought from a bowyer');
  };
  // Savings to spare and no exceptional body armour: one from a resident smith (market.ts).
  const upgradeArmour = async () => {
    const exceptional = goodMatch('exceptional armour');
    const worn = session.world.childrenOf(ctx.serial);
    await learnQuality(session, worn);
    if (worn.some(exceptional) || saving(ctx) || ctx.status().gold + knownBankGold(ctx.checkpoint) < 2000) return;
    if (!(await buyAtMarket({ ...ctx, city: ctx.home.city }, 'exceptional armour', 1, 3).catch(() => 0))) return;
    await learnQuality(session, contents());
    // Worn by the inventory pass when it beats what is on (inventory-use.ts).
    log('Bought exceptional armour from a resident smith');
  };
  const restock = async () => {
    if (forcedToWork(session)) return;
    const table = supplies();
    // Fighters living in a potion market town try fellow residents first (market.ts).
    for (const good of ['heal potions', 'cure potions', 'poison potions'] as const) {
      const [want = 0, enough = 0] = table.get(goods[good].graphic) ?? [];
      if (goods[good].market !== ctx.home.city.toLowerCase() || count(goods[good].graphic) >= enough) continue;
      await buyAtMarket({ ...ctx, city: ctx.home.city }, good, want - count(goods[good].graphic), 3).catch(() => 0);
    }
    // Now and then an archer looks for an exceptional bow at the bow market (market.ts).
    if (weaponSkill(ctx.template) === 'Archery' && Math.random() < 0.25) await upgradeBow();
    // Melee fighters now and then look for a resident smith's armour.
    else if (weaponSkill(ctx.template) !== 'Archery' && Math.random() < 0.15) await upgradeArmour();
    // Nothing to buy with: no shopping walk at all.
    if (status().gold + knownBankGold(checkpoint) < 50 && !fundsStale(checkpoint)) return;
    phase('restocking', 'Looking for supplies sold by ordinary vendors');
    const stops = [
      ...(weaponSkill(ctx.template) === 'Archery' ? ctx.home.all('bowyer') : []),
      ...(casts() ? ctx.home.all('mage') : []),
      ...ctx.home.shops
    ];
    for (const shop of stops) {
      check();
      if ([...table].every(([graphic, [, enough]]) => count(graphic) >= (enough ?? 0))) break;
      // A shop in another town (Britain's, for an island town lacking one) is worth the moongate
      // trip only with nothing at all to heal with, and at most every two hours: supplies are
      // optional, hunting is the job.
      if (distance(shop, ctx.home.town) > 300) {
        const broke = status().gold + knownBankGold(checkpoint) < 100;
        if (broke || ctx.count(bandage) || ctx.count(healPotion) || Date.now() < (checkpoint.farShopAfter ?? 0))
          continue;
        checkpoint.farShopAfter = Date.now() + 2 * 3_600_000;
        ctx.persist();
      }
      // A stop that buys nothing is not walked to again for two hours (objective-memory.ts).
      await errand(ctx, `restock:${shop.x},${shop.y}`, `restocking at ${shop.x},${shop.y}`, async () => {
        await travelNear(ctx, shop, 5);
        const needs = [...table]
          .filter(([graphic, [want]]) => count(graphic) < (want ?? 0))
          .map(([graphic]) => graphic);
        for (const mobile of learning.order(nearby(), 3006103, needs)) {
          const before = session.world.received.get(0x74) ?? 0;
          if (!(await contextAction(mobile, 3006103, needs))) continue;
          try {
            await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'vendor stock', 2500);
          } catch {
            check();
            learning.record(mobile, 3006103, 'unavailable', needs);
            continue;
          }
          const offers = [...session.world.buyOffers.values()].flat();
          if (
            !offers.some((offer) => {
              const item = session.world.entities.get(offer.serial);
              const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
              return item && stock?.parent === mobile.serial && needs.includes(item.graphic) && (item.amount ?? 0) > 0;
            })
          )
            learning.record(mobile, 3006103, 'no-stock', needs);
          for (const offer of offers) {
            const item = session.world.entities.get(offer.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            const limits = item ? table.get(item.graphic) : undefined;
            if (!item || stock?.parent !== mobile.serial || !limits) continue;
            await session.refreshStatus();
            // Vendors charge carried gold, then the bank; keep 150 of the combined funds untouched.
            const funds = status().gold + knownBankGold(checkpoint) - 150;
            // A reagent stock of ninety costs more than ordinary supplies; other purchases stay small.
            const cap = combatReagents.includes(item.graphic) ? 600 : 200;
            const wanted = (limits[0] ?? 0) - count(item.graphic);
            const amount = Math.min(
              wanted,
              item.amount ?? 1,
              Math.floor(Math.max(0, funds) / offer.price),
              Math.floor(cap / offer.price)
            );
            if (amount < 1 || amount * offer.price > cap || offer.price > (limits[2] ?? 0)) continue;
            await approachVendor(ctx, mobile.serial);
            await chargedPurchase(ctx, amount * offer.price, () =>
              session.purchaseItem(mobile.serial, item.serial, ctx.backpack(), amount, Math.min(cap, funds))
            );
            learning.record(mobile, 3006103, 'success', needs);
            log(`Bought ${amount} supplies (graphic ${item.graphic.toString(16)})`);
            await Bun.sleep(700);
          }
        }
      });
    }
  };
  const sellLoot = async () => {
    if (forcedToWork(session)) return;
    phase('selling', 'Offering recorded loot to vendors who actually buy those items');
    const saleStops = [
      ...(contents().some(
        (item) =>
          trip.loot.includes(item.serial) &&
          (terrain.tile(item.graphic, true).flags & (0x2 | 0x08000000) ||
            (item.graphic >= 0x144e && item.graphic <= 0x1457))
      )
        ? [ctx.home.one('blacksmith')]
        : []),
      ...(contents().some((item) => trip.loot.includes(item.serial) && item.graphic >= 0xf10 && item.graphic <= 0xf30)
        ? [ctx.home.one('jeweler')]
        : [])
    ];
    if (contents().some((item) => trip.loot.includes(item.serial) && item.graphic >= 0x1f2d && item.graphic <= 0x1f6c))
      saleStops.push(ctx.home.one('mage'));
    // Magic, blessed, artifact and exceptional loot is kept, never sold at base price (item-quality.ts).
    await learnQuality(
      session,
      contents().filter((item) => trip.loot.includes(item.serial))
    );
    for (const shop of saleStops) {
      if (!contents().some((item) => trip.loot.includes(item.serial) && item.graphic !== gold)) break;
      // The shop may be across water (Britain's for an island town): travelNear takes the moongate.
      // A stop that buys nothing is not walked to again for two hours (objective-memory.ts).
      await errand(ctx, `sell:${shop.x},${shop.y}`, `selling at ${shop.x},${shop.y}`, async () => {
        await travelNear(ctx, shop, 5);
        for (const mobile of learning.order(nearby(), 3006104)) {
          session.world.sellOffers.delete(mobile.serial);
          if (!(await contextAction(mobile, 3006104))) continue;
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
                    ![bandage, healPotion, curePotion].includes(owned.graphic)
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
          learning.record(mobile, 3006104, 'success');
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
        const bankers = learning.order(nearby(), 3006105);
        if (!bankers.length) log(`No vendor in view at the bank near ${location.x},${location.y}`);
        for (const mobile of bankers) {
          const opened = await openBank(mobile, pass > 0);
          if (opened === undefined) continue;
          const box = { serial: opened };
          await Bun.sleep(500);
          // Keep a small purse for player trades and any unsettled companion share.
          let pocket = pocketReserve(checkpoint);
          for (const item of contents()) {
            check();
            if (item.graphic === gold) {
              const kept = Math.min(pocket, item.amount ?? 1);
              pocket -= kept;
              const deposit = (item.amount ?? 1) - kept;
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
          learning.record(mobile, 3006105, 'success');
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
  const rest = async () => {
    if (status().hits < status().maxHits * 0.9 && nearAnyGround(position())) await navigate(ctx.home.town, 4);
    phase('recovering-health', 'Recovering in town before another fight');
    // Town is safe: keep resting (natural regeneration plus bandages) for up to twenty minutes
    // rather than abandoning the run after a fixed short wait.
    const until = Math.min(deadline, Date.now() + 20 * 60_000);
    while ((status().hits < status().maxHits * 0.9 || (session.world.poisonLevel ?? 0) > 0) && Date.now() < until) {
      check();
      await heal();
      await Bun.sleep(2500);
      await session.refreshStatus();
    }
    if (status().hits < status().maxHits * 0.8 || (session.world.poisonLevel ?? 0) > 0)
      throw new Error('Insufficient recovery to hunt safely');
  };
  return { contextAction, openBank, restock, sellLoot, bank, rest };
}
