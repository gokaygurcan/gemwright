import { fundsStale, spendableGold } from './bank-gold';
import { craftRecipes } from './craft-training';
import { serviceLocations } from './locations';
import { createSmithing } from './miner-crafting';
import type { createMinerServices } from './miner-services';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { createServiceExperience } from './service-experience';

const ingot = 0x1bf2;

// Everything a smith makes from iron (catalogs/crafts/blacksmith.json; a label is 1020000 + graphic).
export const smithed = new Set(craftRecipes('Blacksmith').map((recipe) => recipe.label - 1020000));

export function createIngotSeller(
  ctx: Parameters<typeof createMinerServices>[0],
  learning: ReturnType<typeof createServiceExperience>
) {
  const { session, checkpoint, city, shops, navigate, position, check, status, phase, log, carried, progress } = ctx;
  const smithing = createSmithing(ctx);
  // A miner turns surplus into working funds: sell iron ingots to a smith when the bank already
  // holds a reserve or the character is short of gold for tools and a horse.
  const INGOT_RESERVE = 300;
  // Unknown funds count as sufficient until a banker has reported a balance.
  const shouldSell = (backpack: number) =>
    (checkpoint.stock?.ingots ?? 0) >= INGOT_RESERVE ||
    (!fundsStale(checkpoint) && spendableGold(session, backpack, checkpoint) < 1000);
  // `force` skips the reserve rule: iron withdrawn for idle-time smithing is meant to be worked and sold.
  const sellIngots = async (backpack: number, force = false) => {
    const iron =
      (force || shouldSell(backpack)) && carried(backpack).some((item) => item.graphic === ingot && !item.hue);
    // Smithed goods already carried are always sold, whatever the iron rules say.
    const goods = carried(backpack).some((item) => smithed.has(item.graphic));
    if (!iron && !goods) return;
    // Surplus iron is worth more as the best-value smithed item than as raw ingots.
    // Smithing is optional: an unreachable anvil or a refused craft falls back to selling raw iron.
    let made: Awaited<ReturnType<typeof smithing.craft>> = [];
    if (iron)
      try {
        made = await smithing.craft(backpack);
      } catch (error) {
        check();
        log(`Smithing unavailable (${error instanceof Error ? error.message : error}); selling raw iron instead`);
      }
    const crafted = new Set(made.map((item) => item.serial));
    // Smithed goods from earlier sessions are sold too, never carried around for good.
    phase(
      'selling',
      `Offering ${crafted.size ? `${crafted.size} crafted items and ` : ''}surplus iron to an ordinary smith`
    );
    // Smiths buy iron ingots (ServUO SBBlacksmith); the tool shops are a fallback route.
    for (const shop of [...serviceLocations(city, 'blacksmith'), ...shops]) {
      await navigate(shop, 4);
      for (const mobile of learning.order([...session.world.entities.values()], 3006104, [ingot])) {
        if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
        if (mobile.serial === session.world.serial || learning.blocked(mobile, 3006104, [ingot])) continue;
        check();
        let entry: Awaited<ReturnType<PlayerSession['context']>>[number] | undefined;
        try {
          entry = (await session.context(mobile.serial)).find((e) => e.cliloc === 3006104 && !(e.flags & 1));
        } catch (error) {
          if (session.phase !== 'ready') throw error;
        }
        if (!entry) continue;
        try {
          await approachVendor(ctx, mobile.serial);
        } catch {
          check();
          learning.record(mobile, 3006104, 'unreachable', [ingot]);
          continue;
        }
        session.world.sellOffers.delete(mobile.serial);
        session.selectContext(mobile.serial, entry.index);
        try {
          await session.waitFor(() => session.world.sellOffers.has(mobile.serial), 'smith buying list', 2500);
        } catch {
          check();
          continue;
        }
        // Whole stacks only: a partial sale leaves the serial behind and cannot be confirmed.
        const sale = (session.world.sellOffers.get(mobile.serial) ?? []).filter((offer) => {
          const item = session.world.entities.get(offer.serial);
          return (
            item?.parent === backpack &&
            offer.price > 0 &&
            offer.amount === item.amount &&
            (crafted.has(item.serial) || smithed.has(item.graphic) || (iron && item.graphic === ingot && !item.hue))
          );
        });
        if (!sale.length) {
          learning.record(mobile, 3006104, 'no-service', [ingot]);
          continue;
        }
        const before = status().gold;
        await session.sell(
          mobile.serial,
          sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
        );
        await session.refreshStatus();
        learning.record(mobile, 3006104, 'success', [ingot]);
        progress.sold += sale.reduce((sum, offer) => sum + offer.amount, 0);
        const items = sale.filter((offer) => crafted.has(offer.serial)).length;
        phase(
          'sold',
          `Sold ${items} crafted items and ${sale.reduce((sum, o) => sum + (crafted.has(o.serial) ? 0 : o.amount), 0)} ingots for ${status().gold - before} gold`
        );
        return;
      }
    }
    log('No smith along the shop route bought iron ingots; banking them instead');
  };
  return sellIngots;
}
