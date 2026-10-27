import { chargedPurchase, fundsStale, queryBankBalance, spendableGold } from './bank-gold';
import { Blocked } from './blocked';
import { travelNear } from './cemeteries';
import {
  bandage,
  curePotion,
  type FighterContext,
  healPotion,
  meleeWeapons,
  weaponSkill,
  weaponsFor
} from './fighter-context';
import { createFighterGear } from './fighter-gear';
import { serviceLocations } from './locations';
import { forcedToWork } from './loop-watch';
import { prepareSpellbook } from './magery';
import { approachVendor } from './mobile-approach';
import { errand } from './objective-memory';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';
import { createServiceExperience } from './service-experience';
import { trainingVisit } from './training';

export { reportedBankGold } from './bank-gold';

export function createFighterEquipment(
  ctx: FighterContext,
  services: {
    contextAction: (mobile: Entity, cliloc: number) => Promise<boolean>;
    openBank: (mobile: Entity) => Promise<number | undefined>;
    restock: () => Promise<void>;
  }
) {
  const { session, serial, contents, nearby, navigate, phase, check, stats, log, status } = ctx;
  const learning = createServiceExperience(ctx);
  const usable = (item: Entity) =>
    weaponsFor(ctx.template).has(item.graphic) && !gear.retired.has(item.serial) && !gear.refused.has(item.graphic);
  let bareHanded = false;
  // A stand-in wielded while no weapon of its own family is usable (see equip).
  let standIn: number | undefined;
  const equippedSword = () =>
    [...session.world.entities.values()].find(
      (item) =>
        item.parent === serial &&
        (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) &&
        (usable(item) || item.serial === standIn)
    );
  let restockAfter = 0;
  const unarmed = () => weaponsFor(ctx.template).size === 0;
  // Wields the first weapon the server accepts. One it refuses (usually too little strength) is
  // remembered and sold; when every weapon carried is refused, the fighter fights bare-handed until
  // stronger rather than retrying the same lift.
  const equip = async () => {
    if (unarmed() || equippedSword()) return;
    for (let weapon = contents().find(usable); weapon; weapon = contents().find(usable)) {
      const hand = [...session.world.entities.values()].find(
        (item) => item.parent === serial && item.layer === Layer.OneHanded
      );
      if (hand) await session.moveItem(hand.serial, ctx.backpack());
      try {
        await session.equipItem(weapon.serial, Layer.OneHanded);
        bareHanded = false;
        return;
      } catch (error) {
        if (session.phase !== 'ready') throw error;
        gear.refused.add(weapon.graphic);
        if (!ctx.trip.loot.includes(weapon.serial)) ctx.trip.loot.push(weapon.serial);
        log(`Too weak to wield item ${weapon.serial} (${status().strength} strength); selling it`);
      }
    }
    if (gear.refused.size && contents().some((item) => weaponsFor(ctx.template).has(item.graphic))) {
      if (!bareHanded) log('No weapon I carry can be wielded yet; fighting bare-handed until stronger');
      bareHanded = true;
      return;
    }
    // Rather than stand idle in town: the weapon already in hand, else a worn-out one of its own
    // family, else any melee weapon carried (a gift, loot), until a proper one is bought.
    const own = weaponsFor(ctx.template);
    const held = [...session.world.entities.values()].find(
      (item) =>
        item.parent === serial &&
        (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) &&
        (own.has(item.graphic) || meleeWeapons.has(item.graphic))
    );
    if (held) {
      if (standIn !== held.serial) log(`Fighting with item ${held.serial} until I can buy a proper weapon`);
      standIn = held.serial;
      return;
    }
    const spare = [
      ...contents().filter((item) => own.has(item.graphic)),
      ...contents().filter((item) => meleeWeapons.has(item.graphic))
    ].find((item) => !gear.refused.has(item.graphic));
    if (spare) {
      const hand = [...session.world.entities.values()].find(
        (item) => item.parent === serial && item.layer === Layer.OneHanded
      );
      if (hand) await session.moveItem(hand.serial, ctx.backpack());
      try {
        await session.equipItem(spare.serial, Layer.OneHanded);
        standIn = spare.serial;
        ctx.trip.loot = ctx.trip.loot.filter((s) => s !== spare.serial);
        log(`Wielding item ${spare.serial} until I can buy a proper weapon`);
        return;
      } catch (error) {
        if (session.phase !== 'ready') throw error;
        gear.refused.add(spare.graphic);
      }
    }
    // No weapon to be had: fists, on prey weak enough for them (fight cost counts fists), until the
    // loot buys one. Waiting in town never earns one.
    if (!bareHanded) log('No weapon at hand; fighting bare-handed until I can buy one');
    bareHanded = true;
  };
  const gear = createFighterGear(ctx, services.contextAction);
  const bankSupplies = async () => {
    // The home town's banks; Britain's only for a town without one. (Crossing the map to another
    // bank finds the same box, and the trip back is where penniless fighters died.)
    const banks = ctx.home.banks.length ? ctx.home.banks : serviceLocations('Britain', 'banker');
    // Bankers wander around their spawn point, so a bank visit looks from a few spots before
    // giving up on that bank: the landmark, then a few tiles to either side.
    const spots = (landmark: { x: number; y: number }) => [
      landmark,
      ...[
        [6, 0],
        [-6, 0],
        [0, 6]
      ].flatMap(([dx = 0, dy = 0]) => ctx.terrain.stand(landmark.x + dx, landmark.y + dy, ctx.position().z) ?? [])
    ];
    const visits = banks.flatMap((landmark) => spots(landmark).map((spot, index) => ({ landmark, spot, index })));
    const unreachable = new Set<(typeof banks)[number]>();
    for (const { landmark, spot, index } of visits) {
      // A bank that could not be reached is not searched from its other spots.
      if (unreachable.has(landmark)) continue;
      try {
        // From a distant cemetery the bank is reached through the moongate, not a single walk.
        if (index === 0) await travelNear(ctx, landmark, 4);
        else await navigate(spot, 1);
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        if (index === 0) unreachable.add(landmark);
        log(`Bank at ${landmark.x},${landmark.y} ${index === 0 ? 'unreachable' : 'spot skipped'}: ${error.message}`);
        continue;
      }
      for (const mobile of nearby()) {
        check();
        const opened = await services.openBank(mobile);
        if (opened === undefined) continue;
        const box = { serial: opened };
        const wearables = new Set(gear.fromBank(contents(box.serial)).map((item) => item.serial));
        for (const item of contents(box.serial)) {
          if (
            (weaponsFor(ctx.template).has(item.graphic) && !equippedSword() && !contents().some(usable)) ||
            ([bandage, healPotion, curePotion].includes(item.graphic) && !ctx.count(item.graphic)) ||
            wearables.has(item.serial)
          ) {
            await session.moveItem(item.serial, ctx.backpack());
            await Bun.sleep(700);
          }
        }
        learning.record(mobile, 3006105, 'success');
        // Vendors charge the bank balance directly; record it instead of carrying gold.
        await queryBankBalance(ctx, mobile.serial);
        await session.refreshStatus();
        return;
      }
    }
    const shown = nearby().filter((mobile) => mobile.notoriety === 7);
    log(
      `No banker answered; ${shown.length} invulnerable mobiles were within reach (${shown
        .map((m) => m.name ?? m.graphic)
        .slice(0, 6)
        .join(', ')})`
    );
    throw new Error('No observed banker offered access to existing recovery supplies');
  };
  const prepareEquipment = async () => {
    await ctx.refreshBackpack();
    await gear.dress();
    await gear.retireWorn();
    const hasSword = () => unarmed() || !!equippedSword() || contents().some(usable);
    if (hasSword() && (ctx.count(bandage) || ctx.count(healPotion)) && Date.now() < restockAfter) {
      await equip();
      return;
    }
    const spendable = () => spendableGold(session, ctx.backpack(), ctx.checkpoint);
    const reviving = ctx.trip.recovery?.stage === 'equipment';
    // The bank only for a missing weapon (its spare, insurance.ts), at most once an hour: supplies
    // are never worth a trip. An armed fighter goes hunting with what it has.
    const bankLook =
      (reviving || !hasSword()) && !forcedToWork(session) && Date.now() > (ctx.checkpoint.bankLookAfter ?? 0);
    if (bankLook) {
      ctx.checkpoint.bankLookAfter = Date.now() + 3_600_000;
      phase('replacing-equipment', 'Looking in my bank for a weapon or supplies');
      await errand(ctx, 'bank-look', 'looking in my bank', bankSupplies);
      // Put on whatever the bank provided before buying anything new.
      await gear.dress();
    }
    // Penniless, there is nothing to buy: no walk past every shop (fighter.ts earns first).
    const broke = !fundsStale(ctx.checkpoint) && spendable() < 20;
    if (!hasSword() && broke) return;
    if (!hasSword()) {
      // Bows come from the bowyer; melee weapons from the smiths.
      const vendors =
        weaponSkill(ctx.template) === 'Archery'
          ? ctx.home.all('bowyer')
          : [...ctx.home.all('blacksmith'), ...ctx.home.all('weaponsmith')];
      for (const stop of vendors) {
        if (hasSword()) break;
        // A smith that sells nothing is not walked to again for two hours (objective-memory.ts).
        await errand(ctx, `weapon:${stop.x},${stop.y}`, `buying a weapon at ${stop.x},${stop.y}`, async () => {
          await navigate(stop, 5);
          for (const mobile of nearby()) {
            const before = session.world.received.get(0x74) ?? 0;
            if (!(await services.contextAction(mobile, 3006103))) continue;
            try {
              await session.waitFor(
                () => (session.world.received.get(0x74) ?? 0) > before,
                'weapon vendor stock',
                2500
              );
            } catch {
              check();
              continue;
            }
            const offer = [...session.world.buyOffers.values()]
              .flat()
              .filter((offer) => {
                const item = session.world.entities.get(offer.serial);
                const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
                return (
                  item &&
                  weaponsFor(ctx.template).has(item.graphic) &&
                  (item.amount ?? 0) > 0 &&
                  stock?.parent === mobile.serial &&
                  offer.price > 0 &&
                  offer.price <= 150 &&
                  offer.price <= spendable() - 30
                );
              })
              .sort((a, b) => a.price - b.price)[0];
            if (!offer) continue;
            await approachVendor(ctx, mobile.serial);
            await chargedPurchase(ctx, offer.price, () =>
              session.purchaseItem(mobile.serial, offer.serial, ctx.backpack(), 1, 150)
            );
            learning.record(mobile, 3006103, 'success');
            stats.replacementWeapons++;
            phase('replacement-purchased', `Confirmed an ordinary weapon purchase for ${offer.price} gold`);
            break;
          }
        });
      }
    }
    await equip();
    // Casters (primary or support Magery) carry a spellbook with their vendor combat spells.
    const archetype = ctx.template.archetype;
    if (archetype && [...archetype.primarySkills, ...archetype.supportingSkills].includes('Magery'))
      await prepareSpellbook({ ...ctx, city: ctx.home.city, carried: (pack) => contents(pack) });
    restockAfter = Date.now() + 120_000;
    await services.restock();
    await session.refreshStatus();
    await gear.upgradeArmor();
    await trainingVisit(ctx, ctx.home.city);
  };
  return { equip, prepareEquipment, dress: gear.dress };
}
