import { knownBankGold } from './bank-gold';
import { nearAnyGround, returnHome } from './cemeteries';
import { replaceDeathRobe } from './death-robe';
import { escortOpportunity } from './escort';
import { bandage, type FighterContext, healPotion, observedThreat, weaponsFor } from './fighter-context';
import { tidyPack } from './inventory';
import { healOthers } from './mend';
import { distance } from './navigation';
import { playerVendorTurn } from './player-vendors';
import type { ProfessionContext } from './profession';
import { sellingTurn } from './selling';
import { sideTradeTurn } from './side-trade';

// A fighter's errands between hunts, as the general trades run them: back to town to sell, bank
// and tidy; earning when it has no weapon or nothing to heal with; a look at players' shops.
export function createFighterErrands(
  ctx: FighterContext,
  town: {
    sellLoot: () => Promise<unknown>;
    bank: () => Promise<unknown>;
    prepareEquipment: () => Promise<unknown>;
    rest: () => Promise<unknown>;
    acquireMount: () => Promise<unknown>;
  }
) {
  const { session, home, log, status, checkpoint } = ctx;
  // The general trades' helpers take a ProfessionContext; a fighter's covers the same ground.
  const asProfession = (): ProfessionContext => ({
    ...ctx,
    city: home.city,
    carried: (pack?: number) => session.world.childrenOf(pack ?? ctx.backpack()),
    progress: {},
    practise: async () => 0
  });
  const tidyAndSell = async () => {
    await tidyPack(session, ctx.backpack(), log, ctx.terrain);
    await healOthers(ctx, log);
    await sellingTurn(asProfession()).catch(() => false);
    await town.prepareEquipment();
  };

  const shopPlayers = () =>
    !ctx.dead() && !ctx.state.inCombat ? playerVendorTurn(asProfession()).catch(() => false) : Promise.resolve(false);

  const leaveGround = async () => {
    session.setWarMode(false);
    await returnHome(ctx);
    if (nearAnyGround(ctx.position()) || ctx.nearby().some((mobile) => observedThreat(mobile, session.world.combatant)))
      await ctx.escapeNavigate(home.town, 4);
  };
  const returnToTown = async () => {
    await leaveGround();
    await town.sellLoot();
    await town.bank();
    // In town with the loot banked: an escort to another town pays well (escort.ts).
    await escortOpportunity(ctx, status().gold + knownBankGold(checkpoint)).catch(() => false);
  };
  const afterReturn = async () => {
    await tidyAndSell();
    await town.rest();
    await town.acquireMount();
  };

  // Without a weapon or anything to heal with, a fight is a death: it earns instead (an escort,
  // or fishing near town, side-trade.ts) and tries the shops again later. True when it did.
  const earnInstead = async () => {
    const weapons = weaponsFor(ctx.template);
    const armed =
      !weapons.size ||
      [...session.world.childrenOf(ctx.serial), ...session.world.childrenOf(ctx.backpack())].some((item) =>
        weapons.has(item.graphic)
      );
    if (armed && (ctx.count(healPotion) >= 1 || ctx.count(bandage) >= 1)) return false;
    await replaceDeathRobe({ ...ctx, city: home.city, carried: (pack: number) => session.world.childrenOf(pack) });
    if (await escortOpportunity(ctx, status().gold + knownBankGold(checkpoint)).catch(() => false)) return true;
    ctx.phase('earning', `No ${armed ? 'healing supplies' : 'weapon'} and no gold to buy them; earning in town first`);
    // Only where no fisherman is in reach does it wait in town.
    if (!(await sideTradeTurn(asProfession(), 'fighter', true).catch(() => false))) {
      if (distance(ctx.position(), home.town) > 12) await ctx.navigate(home.town, 6).catch(() => {});
      await Bun.sleep(60_000);
    }
    await tidyAndSell();
    return true;
  };

  // After a recent dangerous encounter: a short wait in town before choosing again.
  const waitToReconsider = async () => {
    const { trip } = ctx;
    if ((trip.reconsiderAt ?? 0) <= Date.now()) {
      delete trip.reconsiderAt;
      return false;
    }
    ctx.phase('experience-rest', 'Waiting safely in town before reconsidering a recently dangerous encounter');
    const until = Math.min(ctx.deadline, trip.reconsiderAt ?? 0, Date.now() + 30_000);
    while (Date.now() < until) {
      ctx.check();
      await Bun.sleep(250);
    }
    return true;
  };

  return { waitToReconsider, shopPlayers, leaveGround, returnToTown, afterReturn, earnInstead, tidyAndSell };
}
