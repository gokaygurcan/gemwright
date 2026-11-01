import { gold, ingot, miningTools, ore } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { deposit, withdraw } from './bank-box';
import { chargedPurchase, openBankBox, queryBankBalance } from './bank-gold';
import { clearBankRoom } from './bank-space';
import { Blocked } from './blocked';
import { replaceDeathRobe } from './death-robe';
import { packItems, packSummary } from './inventory';
import { bestRecipe, RAW_INGOT_VALUE } from './miner-crafting';
import { createIngotSeller, smithed } from './miner-selling';
import { createSmelter } from './miner-smelting';
import type { MinerServicesContext } from './miner-types';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { putDown } from './overload';
import { craftedGoods } from './selling';
import { createServiceExperience } from './service-experience';
import { buyOffers } from './vendor-shop';
import { buyFrom, sellTo } from './vendor-trade';

export const tools = miningTools;
// How many piles of unsmeltable ore are worth keeping for a higher Mining skill.
export const ORE_STASH = 10;
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
      for (const mobile of learning.order([...session.world.entities.values()], Actions.bank)) {
        if (!mobile.position || distance(position(), mobile.position) > 12 || learning.blocked(mobile, Actions.bank))
          continue;
        check();
        try {
          const menu = await session.context(mobile.serial);
          const entry = menu.find((item) => item.cliloc === Actions.bank && !(item.flags & 1));
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
    const visit = { banker: banker.serial, box: box.serial };
    // Every move is the shared verified one (bank-box.ts); a refusal keeps the shard's reason.
    const into = async (item: Entity) => {
      const result = await deposit(ctx, visit, [item]);
      for (const refusal of result.refused) log(`The bank refused it: ${refusal.reason}`);
      return result.moved.length > 0;
    };
    const out = async (item: Entity) => (await withdraw(ctx, [item], backpack)).moved.length > 0;
    // A nearly full box first gives back kept pieces to sell (bank-space.ts).
    checkpoint.keep ??= [];
    const freed = await clearBankRoom(session, box.serial, backpack, checkpoint.keep);
    const held = packItems(session, box.serial).length;
    phase(
      'bank-deposit',
      `Depositing ingots; box ${held} items${held >= 110 ? ` (${packSummary(session, box.serial)})` : ''}`
    );
    // The hoard already in the box: ore the forge refuses, beyond the stash this skill may grow into,
    // comes back out and goes down in town. The cap on deposits alone would leave it there for good.
    const boxed = packItems(session, box.serial).filter((item) => ore.has(item.graphic));
    for (const item of boxed.slice(0, Math.min(10, Math.max(0, boxed.length - ORE_STASH)))) {
      check();
      if (await out(item)) await putDown(session, item.serial).catch(() => {});
    }
    // Ore the forge refused would otherwise pin the pack at its weight limit with no way to mine.
    const retained = new Set(retainedOre(backpack).map((item) => item.serial));
    // Ore the forge keeps refusing (this miner's skill is too low for the vein) is banked only to a
    // small stash: mountains of it are dead weight no resident would hoard. The rest goes down in
    // town — it can be picked up again when the skill grows, and the bank stays for what is used.
    const boxedOre = packItems(session, box.serial).filter((item) => ore.has(item.graphic)).length;
    let stash = Math.max(0, ORE_STASH - boxedOre);
    let refused = false;
    for (const item of [...session.world.entities.values()]) {
      // Gold is deposited too: vendors charge the bank, and carried gold is lost on death.
      const kept = !!checkpoint.keep?.includes(item.serial);
      if (
        item.parent !== backpack ||
        (item.graphic !== ingot && item.graphic !== gold && !retained.has(item.serial) && !kept)
      )
        continue;
      if (retained.has(item.serial) && stash-- <= 0) {
        await putDown(session, item.serial).catch(() => {});
        continue;
      }
      check();
      // A full box refuses the deposit: the iron is sold instead, below.
      if (!(await into(item))) {
        refused = true;
        continue;
      }
      if (kept) checkpoint.keep = checkpoint.keep?.filter((serial) => serial !== item.serial);
      if (item.graphic === ingot) progress.deposits += item.amount ?? 1;
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
        if (await out(extra)) toSell.push(extra.serial);
        await session.refreshStatus().catch(() => {});
      }
    for (const item of pieces(backpack)) {
      if (toSell.includes(item.serial)) continue;
      if (!kinds.has(item.graphic) && (await into(item))) {
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
      if (await out(pile)) unsmeltable.delete(pile.serial);
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
    if (confirmedBanker) learning.record(confirmedBanker, Actions.bank, 'success');
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
    const taken = await withdraw(ctx, [stack], backpack, () => amount);
    if (!taken.moved.length) {
      phase('bank-withdraw', `The bank kept the ingots: ${taken.refused[0]?.reason}`);
      return false;
    }
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
      if (!(await buyFrom({ ...ctx, backpack: () => backpack }, 'blacksmith', new Map([[ingot, 16]])))) return false;
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
      for (const mobile of learning.order([...session.world.entities.values()], Actions.buy, [...tools])) {
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
        if (learning.blocked(mobile, Actions.buy, [...tools])) continue;
        let menu: Awaited<ReturnType<PlayerSession['context']>>;
        try {
          menu = await session.context(mobile.serial);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          else continue;
        }
        const buy = menu.find((entry) => entry.cliloc === Actions.buy && !(entry.flags & 1));
        if (!buy) continue;
        try {
          await approachVendor(ctx, mobile.serial);
        } catch (error) {
          check();
          learning.record(mobile, Actions.buy, 'unreachable');
          log(`Tool vendor approach unavailable: ${error instanceof Error ? error.message : 'unknown obstruction'}`);
          continue;
        }
        const stock = await buyOffers(session, mobile.serial, Actions.buy);
        if ('why' in stock) continue;
        const offer = stock.offers
          .filter((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return (
              stock?.parent === mobile.serial &&
              item &&
              tools.has(item.graphic) &&
              (item.amount ?? 0) > 0 &&
              entry.price > 0
            );
          })
          .sort((a, b) => a.price - b.price)[0];
        if (!offer) {
          const stocked = stock.offers.some((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return item && stock?.parent === mobile.serial && tools.has(item.graphic) && (item.amount ?? 0) > 0;
          });
          if (!stocked) learning.record(mobile, Actions.buy, 'no-stock', [...tools]);
          continue;
        }
        phase(
          'resupply-purchase',
          `Buying one mining tool from observed vendor ${mobile.serial} for ${offer.price} gold`
        );
        await approachVendor(ctx, mobile.serial);
        // The vendor charges carried gold, then this character's bank balance; a refusal is a Blocked outcome.
        await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
          session.purchaseItem(mobile.serial, offer.serial, backpack, 1, offer.price)
        );
        learning.record(mobile, Actions.buy, 'success', [...tools]);
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
