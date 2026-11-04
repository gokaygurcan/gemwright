import { arrow, crossbowBolt, curePotion, poisonPotion } from '@gemwright/common/game/items';
import { soldAs } from '@gemwright/common/game/rules';
import { Notoriety } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { ActionTimeout } from './action-errors';
import { chargedPurchase, fundsStale, knownBankGold } from './bank-gold';
import { travelNear } from './cemeteries';
import { actionScope } from './execution-session';
import { ammoFor, bandage, type FighterContext, healPotion, weaponSkill, weaponsFor } from './fighter-context';
import { poisons } from './fighter-poison';
import { forcedToWork } from './loop-watch';
import { combatReagents } from './mage-combat';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { errand, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import type { createServiceExperience } from './service-experience';
import { buyOffers } from './vendor-shop';

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
  _contextAction: (mobile: Entity, action: number, needs?: readonly number[]) => Promise<boolean>,
  learning: ReturnType<typeof createServiceExperience>
) {
  const { session, position, status, count, nearby, check, phase, log, checkpoint } = ctx;
  const supplyName = (graphic: number) => fighterSupplyName(ctx, graphic);
  const casts = () =>
    !!ctx.template.archetype &&
    [...ctx.template.archetype.primarySkills, ...ctx.template.archetype.supportingSkills].includes('Magery');
  // Graphic: [target quantity, minimum on hand]. Targets are kept well above
  // the minimum so a fighter spends its time fighting rather than walking back for supplies.
  const supplies = () => {
    const table = new Map([
      [bandage, [80, 20]],
      [healPotion, [8, 3]],
      [curePotion, [6, 2]]
    ]);
    const weapon = [...session.world.entities.values()].find(
      (item) => item.parent === ctx.serial && weaponsFor(ctx.template).has(item.graphic)
    )?.graphic;
    const ammo = weaponSkill(ctx.template) === 'Archery' ? ammoFor(weapon ?? soldAs('Bow')) : undefined;
    if (ammo) table.set(ammo, [150, 50]);
    // Casters keep every reagent their combat spells use, 150 of each so they rarely walk back to the mage.
    if (casts()) for (const reagent of combatReagents) table.set(reagent, [150, 30]);
    // Poisoners coat their blade before each fight (fighter-poison.ts); alchemists sell the potions.
    if (poisons(ctx)) table.set(poisonPotion, [16, 3]);
    return table;
  };
  const restockNearby = async () => {
    if (forcedToWork(session)) return;
    if (objectiveBlocked(checkpoint, `supplies:${ctx.home.city}`, suppliesCondition(session, checkpoint))) return;
    const localShops = ctx.home.shops.filter((shop) => distance(position(), shop) <= 18);
    if (!localShops.length || status().gold + knownBankGold(checkpoint) < 150) return;
    const table = supplies();
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
          if (mobile.notoriety !== Notoriety.invulnerable || learning.blocked(mobile, Actions.buy, needs)) continue;
          const stock = await buyOffers(session, mobile.serial, Actions.buy);
          if ('why' in stock) {
            if (stock.why === 'no-entry') learning.record(mobile, Actions.buy, 'no-service', needs);
            // The entry was offered and the click went out, but no stock list came: name it and let
            // the memory keep the resident away for half an hour instead of walking back in five
            // minutes (what it did all evening). Busy is ours, not the vendor's: nothing is recorded.
            if (stock.why === 'no-list') {
              learning.record(mobile, Actions.buy, 'no-answer', needs);
              log(`Vendor offered to sell but did not answer: ${needs.map(supplyName).join(', ')} (${mobile.serial})`);
            }
            continue;
          }
          const offers = stock.offers;
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
            const wanted = (limits[0] ?? 0) - count(item.graphic);
            const amount = Math.min(wanted, item.amount ?? 1, Math.floor(Math.max(0, funds) / offer.price));
            if (amount < 1) continue;
            await approachVendor(ctx, mobile.serial);
            await chargedPurchase(ctx, amount * offer.price, () =>
              session.purchaseItem(mobile.serial, item.serial, ctx.backpack(), amount, amount * offer.price)
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
