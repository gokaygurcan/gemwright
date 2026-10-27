import { gold, miningTools, ore } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { chargedPurchase, openBankBox, queryBankBalance } from './bank-gold';
import { clearBankRoom } from './bank-space';
import { Blocked } from './blocked';
import { replaceDeathRobe } from './death-robe';
import { packItems, packSummary } from './inventory';
import { goodMatch, sellCarried } from './market';
import { bestRecipe, RAW_INGOT_VALUE } from './miner-crafting';
import { createIngotSeller, smithed } from './miner-selling';
import { createSmelter } from './miner-smelting';
import type { MinerServicesContext } from './miner-types';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { craftedGoods } from './selling';
import { createServiceExperience } from './service-experience';
import { buyFrom, sellTo } from './vendor-trade';

export const tools = miningTools;
export const ingot = 0x1bf2;
export { forges } from './miner-smelting';
export type { MinerProgress } from './miner-types';

// The Mining skill each coloured ore needs to smelt (ServUO Mining.cs
// resources), by the ore's hue; plain iron needs none.
const oreSkill = new Map([
  [0x973, 65], // dull copper
  [0x966, 70], // shadow iron
  [0x96d, 75], // copper
  [0x972, 80], // bronze
  [0x8a5, 85], // gold
  [0x979, 90], // agapite
  [0x89f, 95], // verite
  [0x8ab, 99] // valorite
]);

export function createMinerServices(ctx: MinerServicesContext) {
  const {
    session,
    checkpoint,
    city,
    banks,
    shops,
    position,
    status,
    check,
    phase,
    log,
    navigate,
    retainedOre,
    unsmeltable,
    plan,
    newTrip,
    progress
  } = ctx;
  const learning = createServiceExperience(ctx);
  const smelt = createSmelter(ctx);
  const findBanker = async () => {
    const observedBanker = async () => {
      for (const mobile of learning.order([...session.world.entities.values()], 3006105)) {
        if (!mobile.position || distance(position(), mobile.position) > 12 || learning.blocked(mobile, 3006105))
          continue;
        check();
        try {
          const menu = await session.context(mobile.serial);
          const entry = menu.find((item) => item.cliloc === 3006105 && !(item.flags & 1));
          if (entry) return { serial: mobile.serial, index: entry.index };
        } catch (error) {
          if (session.phase !== 'ready') throw error;
        }
      }
      return undefined;
    };
    const nearby = await observedBanker();
    if (nearby) return nearby;
    for (const point of [...banks].sort((a, b) => distance(position(), a) - distance(position(), b))) {
      phase('bank-travel', `Travelling to ${city} bank at ${point.x},${point.y}`);
      try {
        await navigate(point, 3);
      } catch (error) {
        check();
        if (!(error instanceof Blocked)) throw error;
        log(`Bank approach blocked: ${error.message}`);
      }
      phase('bank-open', 'Looking for a nearby banker with an enabled open-bank context entry');
      const banker = await observedBanker();
      if (banker) return banker;
    }
    throw new Blocked('no-vendor', 'No reachable banker offered an enabled bank action');
  };
  const sellIngots = createIngotSeller(ctx, learning);
  const bank = async (backpack: number) => {
    // In town anyway: out of the death robe, into new clothes if it has none (death-robe.ts).
    await replaceDeathRobe({ ...ctx, backpack: () => backpack });
    plan().pending = 'bank';
    await sellIngots(backpack);
    const banker = await findBanker();
    const box = { serial: await openBankBox(ctx, banker.serial) };
    await Bun.sleep(500);
    // A nearly full box first gives back kept pieces to sell (bank-space.ts).
    checkpoint.keep ??= [];
    const freed = await clearBankRoom(session, box.serial, backpack, checkpoint.keep);
    const held = packItems(session, box.serial).length;
    phase(
      'bank-deposit',
      `Depositing ingots; box ${held} items${held >= 110 ? ` (${packSummary(session, box.serial)})` : ''}`
    );
    // Ore the forge refused would otherwise pin the pack at its weight limit with no way to mine.
    const retained = new Set(retainedOre(backpack).map((item) => item.serial));
    let refused = false;
    for (const item of [...session.world.entities.values()]) {
      // Gold is deposited too: vendors charge the bank, and carried gold is lost on death.
      const kept = !!checkpoint.keep?.includes(item.serial);
      if (
        item.parent !== backpack ||
        (item.graphic !== ingot && item.graphic !== gold && !retained.has(item.serial) && !kept)
      )
        continue;
      check();
      // A full box refuses the deposit: the iron is sold instead, below.
      if (
        !(await session.moveItem(item.serial, box.serial).then(
          () => true,
          () => false
        ))
      ) {
        refused = true;
        continue;
      }
      if (kept) checkpoint.keep = checkpoint.keep?.filter((serial) => serial !== item.serial);
      if (item.graphic === ingot) progress.deposits += item.amount ?? 1;
      await Bun.sleep(700);
    }
    // Exceptional pieces: one of each kind stays in the bank, the rest are sold with whatever is
    // carried; a pack that holds the only one banks it first.
    const toSell: number[] = [];
    const kinds = new Map<number, Entity[]>();
    const pieces = (container: number) =>
      session.world.childrenOf(container).filter((item) => smithed.has(item.graphic) || craftedGoods.has(item.graphic));
    for (const item of pieces(box.serial)) kinds.set(item.graphic, [...(kinds.get(item.graphic) ?? []), item]);
    for (const [, banked] of kinds)
      for (const extra of banked.slice(1)) {
        // A batch it can carry to the shop; the rest waits for the next bank visit.
        if (status().weight > status().maxWeight * 0.7) break;
        check();
        if (
          await session.moveItem(extra.serial, backpack).then(
            () => true,
            () => false
          )
        )
          toSell.push(extra.serial);
        await Bun.sleep(500);
        await session.refreshStatus().catch(() => {});
      }
    for (const item of pieces(backpack)) {
      if (toSell.includes(item.serial)) continue;
      if (
        !kinds.has(item.graphic) &&
        (await session.moveItem(item.serial, box.serial).then(
          () => true,
          () => false
        ))
      ) {
        kinds.set(item.graphic, [item]);
        continue;
      }
      toSell.push(item.serial);
    }
    // Ore the forge refused earlier comes back out once Mining is high enough to smelt it.
    const mining = session.world.skills.get(skillId('Mining'))?.base ?? 0;
    for (const pile of session.world.childrenOf(box.serial).filter((item) => ore.has(item.graphic))) {
      if (mining < (oreSkill.get(pile.hue ?? 0) ?? 0)) continue;
      if (status().weight + (pile.amount ?? 1) * 12 > status().maxWeight * 0.7) break;
      check();
      if (
        await session.moveItem(pile.serial, backpack).then(
          () => true,
          () => false
        )
      )
        unsmeltable.delete(pile.serial);
      await Bun.sleep(500);
    }
    checkpoint.stock = {
      ingots: [...session.world.entities.values()]
        // Iron only (hue 0): colored ingots are kept, never sold, and must not trigger iron sales.
        .filter((item) => item.parent === box.serial && item.graphic === ingot && !item.hue)
        .reduce((sum, item) => sum + (item.amount ?? 1), 0),
      at: Date.now()
    };
    await queryBankBalance({ ...ctx, checkpoint }, banker.serial);
    const confirmedBanker = session.world.entities.get(banker.serial);
    if (confirmedBanker) learning.record(confirmedBanker, 3006105, 'success');
    // Exceptional armour goes to fighters at the Minoc market first, for more than the shop pays.
    if (toSell.some((serial) => goodMatch('exceptional armour')(session.world.entities.get(serial) ?? ({} as Entity))))
      await sellCarried(
        { session, checkpoint, city, position, navigate, phase, backpack: () => backpack },
        'exceptional armour',
        3
      ).catch(() => 0);
    if (freed.length || toSell.length)
      await sellTo(
        { ...ctx, backpack: () => backpack },
        'blacksmith',
        (item) => freed.includes(item.serial) || toSell.includes(item.serial),
        true
      );
    if (refused) await sellIngots(backpack, true);
    progress.trips++;
    checkpoint.mining = newTrip();
    await session.refreshStatus();
    phase('bank-complete', `Confirmed bank trip ${progress.trips}; deposited ${progress.deposits} ingots this run`);
  };
  // Takes up to `most` banked iron ingots, at least `least`; false when the bank holds too few.
  const withdrawIngots = async (backpack: number, least: number, most: number) => {
    if ((checkpoint.stock?.ingots ?? 0) < least) return false;
    const banker = await findBanker();
    const box = await openBankBox(ctx, banker.serial);
    await Bun.sleep(500);
    const stack = [...session.world.entities.values()]
      .filter((item) => item.parent === box && item.graphic === ingot && !item.hue)
      .sort((a, b) => (b.amount ?? 1) - (a.amount ?? 1))[0];
    if (!stack || (stack.amount ?? 1) < least) {
      if (checkpoint.stock) checkpoint.stock = { ingots: stack?.amount ?? 0, at: Date.now() };
      return false;
    }
    const amount = Math.min(stack.amount ?? 1, most);
    phase('bank-withdraw', `Taking ${amount} banked iron ingots to work`);
    await session.moveItem(stack.serial, backpack, amount);
    if (checkpoint.stock) checkpoint.stock = { ingots: (checkpoint.stock.ingots ?? 0) - amount, at: Date.now() };
    ctx.persist();
    return true;
  };
  // With every nearby vein worked out, a smith turns banked iron into goods instead of standing idle.
  // Short of banked iron, a recipe paying more than the vendor's 5 gold an ingot (SBBlacksmith) is
  // worth buying the metal for.
  const smithFromBank = async (backpack: number) => {
    const recipe = bestRecipe(session.world.skills.get(skillId('Blacksmith'))?.base ?? 0);
    if (!recipe || recipe.perIngot <= RAW_INGOT_VALUE) return false;
    if ((checkpoint.stock?.ingots ?? 0) < recipe.ingots) {
      if (recipe.perIngot <= 5) return false;
      phase(
        'buy-ingots',
        `Buying iron from the smith for ${recipe.name}s (${recipe.perIngot.toFixed(1)} gold an ingot)`
      );
      if (!(await buyFrom({ ...ctx, backpack: () => backpack }, 'blacksmith', new Map([[0x1bf2, 16]]), 5)))
        return false;
    } else if (!(await withdrawIngots(backpack, recipe.ingots, recipe.ingots * 8))) return false;
    const sold = progress.sold;
    await sellIngots(backpack, true);
    return progress.sold > sold;
  };
  const resupply = async (backpack: number) => {
    const count = () =>
      [...session.world.entities.values()].filter((item) => item.parent === backpack && tools.has(item.graphic)).length;
    if (count() >= 2) return;
    try {
      await buyTool(backpack, count);
    } catch (error) {
      // A spare tool is optional; keep mining with the carried one when the shop route fails legally.
      if (!(error instanceof Blocked) || count() === 0) throw error;
      log(`Spare tool unavailable (${error.reason}): ${error.message}; continuing with the carried tool`);
    }
  };
  const buyTool = async (backpack: number, count: () => number) => {
    phase('resupply', 'Looking for an ordinary vendor selling a spare mining tool, up to 100 gold');
    const inspected = new Set<number>();
    for (const landmark of [position(), ...shops]) {
      await navigate(landmark, 3);
      for (const mobile of learning.order([...session.world.entities.values()], 3006103, [...tools])) {
        if (
          mobile.kind !== 'mobile' ||
          mobile.serial === session.world.serial ||
          !mobile.position ||
          distance(position(), mobile.position) > 8 ||
          inspected.has(mobile.serial)
        )
          continue;
        check();
        inspected.add(mobile.serial);
        if (learning.blocked(mobile, 3006103, [...tools])) continue;
        let menu: Awaited<ReturnType<PlayerSession['context']>>;
        try {
          menu = await session.context(mobile.serial);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          else continue;
        }
        const buy = menu.find((entry) => entry.cliloc === 3006103 && !(entry.flags & 1));
        if (!buy) continue;
        try {
          await approachVendor(ctx, mobile.serial);
        } catch (error) {
          check();
          learning.record(mobile, 3006103, 'unreachable');
          log(`Tool vendor approach unavailable: ${error instanceof Error ? error.message : 'unknown obstruction'}`);
          continue;
        }
        const freshBuy = (await session.context(mobile.serial)).find(
          (entry) => entry.cliloc === 3006103 && !(entry.flags & 1)
        );
        if (!freshBuy) continue;
        session.world.buyOffers.clear();
        const before = session.world.received.get(0x74) ?? 0;
        session.selectContext(mobile.serial, freshBuy.index);
        try {
          await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'vendor stock', 2500);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          else continue;
        }
        const offer = [...session.world.buyOffers.values()]
          .flat()
          .filter((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return (
              stock?.parent === mobile.serial &&
              item &&
              tools.has(item.graphic) &&
              (item.amount ?? 0) > 0 &&
              entry.price > 0 &&
              entry.price <= 100
            );
          })
          .sort((a, b) => a.price - b.price)[0];
        if (!offer) {
          const stocked = [...session.world.buyOffers.values()].flat().some((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return item && stock?.parent === mobile.serial && tools.has(item.graphic) && (item.amount ?? 0) > 0;
          });
          if (!stocked) learning.record(mobile, 3006103, 'no-stock', [...tools]);
          continue;
        }
        phase(
          'resupply-purchase',
          `Buying one mining tool from observed vendor ${mobile.serial} for ${offer.price} gold`
        );
        await approachVendor(ctx, mobile.serial);
        // The vendor charges carried gold, then this character's bank balance; a refusal is a Blocked outcome.
        await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
          session.purchaseItem(mobile.serial, offer.serial, backpack, 1, 100)
        );
        learning.record(mobile, 3006103, 'success', [...tools]);
        progress.purchases++;
        phase('resupply-complete', 'Confirmed the purchased tool in the backpack');
        return;
      }
    }
    throw new Blocked(
      count() ? 'no-vendor' : 'missing-tool',
      'No stocked mining-tool vendor found along the current Britain shop route'
    );
  };
  return { smelt, bank, resupply, smithFromBank, withdrawIngots };
}
