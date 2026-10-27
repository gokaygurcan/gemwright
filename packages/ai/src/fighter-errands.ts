import { knownBankGold } from './bank-gold';
import { nearAnyGround, returnHome } from './cemeteries';
import { replaceDeathRobe } from './death-robe';
import { escortOpportunity } from './escort';
import { type FighterContext, meleeWeapons, observedThreat, weaponsFor } from './fighter-context';
import { insuranceTurn } from './insurance';
import { tidyPack } from './inventory';
import { forcedToWork } from './loop-watch';
import { healOthers } from './mend';
import { playerVendorTurn } from './player-vendors';
import type { ProfessionContext } from './profession';
import { Layer } from './protocol/layers';
import { markHere, recallNear, registerRecall } from './recall';
import { scribeTurn, useScrolls } from './scribe';
import { sellingTurn } from './selling';
import { ticketTurn } from './young-ticket';

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
    // In town at the bank: a rune marked there for the way back from the next hunt (recall.ts).
    registerRecall(asProfession());
    await ticketTurn(asProfession()).catch(() => false);
    await insuranceTurn(asProfession()).catch(() => false);
    await useScrolls(asProfession()).catch(() => {});
    await scribeTurn(asProfession()).catch(() => false);
    await markHere(asProfession(), `${home.city} bank`).catch(() => false);
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
    // A caster with a rune for home recalls out instead of walking back through the wilds.
    if (!(await recallNear(asProfession(), home.town).catch(() => false))) await leaveGround();
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
    if (forcedToWork(session)) return false;
    const weapons = weaponsFor(ctx.template);
    const armed =
      !weapons.size ||
      [...session.world.childrenOf(ctx.serial), ...session.world.childrenOf(ctx.backpack())].some((item) =>
        weapons.has(item.graphic)
      );
    // Armed is enough: hunting is how a fighter earns, healing supplies or not (fight confidence
    // already counts what it can heal with). Any melee weapon in hand will do.
    const inHand = session.world
      .childrenOf(ctx.serial)
      .some(
        (item) => (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) && meleeWeapons.has(item.graphic)
      );
    if (armed || inHand) return false;
    // Unarmed after a death: the spare weapon kept in the bank first (insurance.ts).
    if (!armed && (await insuranceTurn(asProfession()).catch(() => false))) return true;
    await replaceDeathRobe({ ...ctx, city: home.city, carried: (pack: number) => session.world.childrenOf(pack) });
    // No spare: it hunts bare-handed (fighter-equipment.ts equip) until the loot buys a weapon.
    // No begging, escorting or waiting in town: none of them earns a weapon.
    return false;
  };

  // After a recent dangerous encounter: a short wait in town before choosing again.
  const waitToReconsider = async () => {
    if (forcedToWork(session)) return false;
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

  return {
    waitToReconsider,
    shopPlayers,
    leaveGround,
    returnToTown,
    afterReturn,
    earnInstead,
    tidyAndSell,
    asProfession
  };
}
