import { arrow, crossbowBolt, curePotion, poisonPotion } from '@gemwright/common/game/items';
import { Layer } from '@gemwright/network/layers';
import { Opcode } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { ActionTimeout } from './action-errors';
import { chargedPurchase, fundsStale, knownBankGold } from './bank-gold';
import { travelNear } from './cemeteries';
import { actionScope } from './execution-session';
import { ammoFor, bandage, type FighterContext, healPotion, weaponSkill, weaponsFor } from './fighter-context';
import { poisons } from './fighter-poison';
import { saving } from './housing';
import { learnQuality } from './item-quality';
import { forcedToWork } from './loop-watch';
import { combatReagents } from './mage-combat';
import { buyAtMarket, goodMatch, goods } from './market';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { errand, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { goalAllows } from './resident-goal';
import type { createServiceExperience } from './service-experience';

export const fighterSupplyName = (ctx: Pick<FighterContext, 'terrain'>, graphic: number) =>
  new Map([
    [bandage, 'bandages'],
    [healPotion, 'greater heal potions'],
    [curePotion, 'cure potions'],
    [poisonPotion, 'poison potions'],
    [arrow, 'arrows'],
    [crossbowBolt, 'crossbow bolts']
  ]).get(graphic) ??
  (ctx.terrain.tile(graphic, true).name || `item 0x${graphic.toString(16)}`);

export function createFighterRestock(
  ctx: FighterContext,
  contextAction: (mobile: Entity, action: number, needs?: readonly number[]) => Promise<boolean>,
  learning: ReturnType<typeof createServiceExperience>
) {
  const { session, position, status, contents, count, nearby, check, phase, log, checkpoint } = ctx;
  const supplyName = (graphic: number) => fighterSupplyName(ctx, graphic);
  const casts = () =>
    !!ctx.template.archetype &&
    [...ctx.template.archetype.primarySkills, ...ctx.template.archetype.supportingSkills].includes('Magery');
  // Graphic: [target quantity, minimum on hand, maximum unit price]. Targets are kept well above
  // the minimum so a fighter spends its time fighting rather than walking back for supplies.
  const supplies = () => {
    const table = new Map([
      [bandage, [80, 20, 8]],
      [healPotion, [8, 3, 60]],
      [curePotion, [6, 2, 60]]
    ]);
    const weapon = [...session.world.entities.values()].find(
      (item) => item.parent === ctx.serial && weaponsFor(ctx.template).has(item.graphic)
    )?.graphic;
    const ammo = weaponSkill(ctx.template) === 'Archery' ? ammoFor(weapon ?? 0x13b2) : undefined;
    if (ammo) table.set(ammo, [150, 50, 4]);
    // Casters keep every reagent their combat spells use (SBMage sells them for 3-5 gold).
    // Casters carry 150 of each reagent so they rarely walk back to the mage.
    if (casts()) for (const reagent of combatReagents) table.set(reagent, [150, 30, 7]);
    // Poisoners coat their blade before each fight (fighter-poison.ts); alchemists sell the potions.
    if (poisons(ctx)) table.set(poisonPotion, [16, 3, 40]);
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
  const restockNearby = async () => {
    if (forcedToWork(session)) return;
    if (objectiveBlocked(checkpoint, `supplies:${ctx.home.city}`, suppliesCondition(session, checkpoint))) return;
    const localShops = ctx.home.shops.filter((shop) => distance(position(), shop) <= 18);
    if (!localShops.length || status().gold + knownBankGold(checkpoint) < 150) return;
    const table = supplies();
    // Fighters living in a potion market town try fellow residents first (market.ts).
    for (const good of ['heal potions', 'cure potions', 'poison potions'] as const) {
      const [want = 0, enough = 0] = table.get(goods[good].graphic) ?? [];
      if (
        !goalAllows(session, 'optional') ||
        goods[good].market !== ctx.home.city.toLowerCase() ||
        count(goods[good].graphic) >= enough
      )
        continue;
      await buyAtMarket({ ...ctx, city: ctx.home.city }, good, want - count(goods[good].graphic), 3).catch(() => 0);
    }
    // Now and then an archer looks for an exceptional bow at the bow market (market.ts).
    if (goalAllows(session, 'optional')) {
      if (weaponSkill(ctx.template) === 'Archery' && Math.random() < 0.25) await upgradeBow();
      else if (weaponSkill(ctx.template) !== 'Archery' && Math.random() < 0.15) await upgradeArmour();
    }
    // Nothing to buy with: no shopping walk at all.
    if (status().gold + knownBankGold(checkpoint) < 50 && !fundsStale(checkpoint)) return;
    const requested = () =>
      [...table]
        .filter(([graphic, [want = 0]]) => count(graphic) < want)
        .map(([graphic, [want = 0]]) => `${want - count(graphic)} ${supplyName(graphic)}`)
        .join(', ');
    phase('restocking', `Looking for ${requested()}`);
    const stops = [
      ...(weaponSkill(ctx.template) === 'Archery' ? ctx.home.all('bowyer') : []),
      ...(casts() ? ctx.home.all('mage') : []),
      ...localShops
    ]
      .filter((shop) => distance(position(), shop) <= 18)
      .sort((a, b) => distance(position(), a) - distance(position(), b))
      .slice(0, 1);
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
      await errand(ctx, `restock:${shop.x},${shop.y}`, `restocking ${requested()} at ${shop.x},${shop.y}`, async () => {
        await travelNear(ctx, shop, 5);
        const needs = [...table]
          .filter(([graphic, [want]]) => count(graphic) < (want ?? 0))
          .map(([graphic]) => graphic);
        for (const mobile of learning.order(nearby(), Actions.buy, needs)) {
          const before = session.world.received.get(Opcode.vendorBuyList) ?? 0;
          if (!(await contextAction(mobile, Actions.buy, needs))) continue;
          try {
            await session.waitFor(
              () => (session.world.received.get(Opcode.vendorBuyList) ?? 0) > before,
              'vendor stock',
              2500
            );
          } catch {
            check();
            // The entry was offered and the click went out, but no stock list came: name it and let
            // the memory keep the resident away for half an hour instead of walking back in five
            // minutes (what it did all evening).
            learning.record(mobile, Actions.buy, 'no-answer', needs);
            log(`Vendor offered to sell but did not answer: ${needs.map(supplyName).join(', ')} (${mobile.serial})`);
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
            learning.record(mobile, Actions.buy, 'no-stock', needs);
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
            learning.record(mobile, Actions.buy, 'success', needs);
            log(`Bought ${amount} ${supplyName(item.graphic)}`);
            await Bun.sleep(700);
          }
        }
      });
    }
    // Nothing was bought and something is still short: the town could not supply the fighter. The
    // trip layer reads this memory (fighter-trip.ts), so the next hours are spent hunting.
    const short = [...table].filter(([graphic, [want = 0]]) => count(graphic) < want);
    if (short.length && ![...table].every(([graphic, [, enough]]) => count(graphic) >= (enough ?? 0))) {
      failObjective(
        checkpoint,
        `supplies:${ctx.home.city}`,
        suppliesCondition(session, checkpoint),
        'no vendor in this town supplied the restock'
      );
      log(`No vendor supplied ${requested()}; hunting with what I have and trying again later`);
    }
  };
  const restock = async () => {
    try {
      await actionScope(session, 'recovery', 'Optional nearby supplies before combat', restockNearby, 15_000);
    } catch (error) {
      if (!(error instanceof ActionTimeout)) throw error;
      failObjective(
        checkpoint,
        `supplies:${ctx.home.city}`,
        suppliesCondition(session, checkpoint),
        'Optional supply visit used its time budget'
      );
      log('Supply visit ended; returning to combat with what I have');
    }
  };
  return restock;
}
