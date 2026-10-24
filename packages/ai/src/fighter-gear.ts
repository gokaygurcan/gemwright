import { chargedPurchase, fundsStale, spendableGold } from './bank-gold';
import { type FighterContext, weaponsFor } from './fighter-context';
import { approachVendor } from './mobile-approach';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';

const deathRobe = 0x204e;
// Hair, backpack, mount and bank layers are never dressed from the backpack.
const reserved = new Set<number>([0, Layer.Hair, Layer.FacialHair, Layer.Backpack, Layer.Mount, Layer.Bank]);
// AOS strength requirements from the pinned ServUO armor scripts, most specific name first.
// The server remains authoritative; a refusal is remembered for this session.
const armorFamilies: [RegExp, number][] = [
  [/plate.*gorget/i, 45],
  [/plate.*(glove|gauntlet)/i, 70],
  [/plate.*arm/i, 80],
  [/plate.*leg/i, 90],
  [/plate.*helm/i, 80],
  [/plate/i, 95],
  [/chain/i, 60],
  [/ring/i, 40],
  [/bone helm/i, 20],
  [/bone.*(chest|tunic)/i, 60],
  [/bone/i, 55],
  [/studded.*(chest|tunic)/i, 35],
  [/studded.*leg/i, 30],
  [/studded/i, 25],
  [/leather.*(chest|tunic)/i, 25],
  [/leather/i, 20],
  [/bascinet/i, 40],
  [/close helm|norse/i, 55],
  [/helmet/i, 45],
  [/heater/i, 90],
  [/metal kite|metal shield/i, 45],
  [/bronze/i, 35],
  [/buckler|wooden/i, 20]
];
// The armor slots a fighter fills: shield, legs, helm, gloves, neck, chest and arms.
const armorLayers = new Set<number>([
  Layer.TwoHanded,
  Layer.Pants,
  Layer.Helm,
  Layer.Gloves,
  Layer.Neck,
  Layer.InnerTorso,
  Layer.Arms
]);
const ARMOR_RESERVE = 750;
const ARMOR_PIECE_LIMIT = 150;
// Below this share of its maximum durability a piece is retired and replaced (no NPC repairs on
// ServUO pub57; repair needs Blacksmithy at a forge and anvil).
const WORN_SHARE = 0.25;
const REPLACEMENT_RESERVE = 200;

export function createFighterGear(
  ctx: FighterContext,
  contextAction: (mobile: Entity, cliloc: number) => Promise<boolean>
) {
  const { session, terrain, serial, contents, nearby, navigate, phase, check, log, trip, status } = ctx;
  const worn = (layer: number) =>
    [...session.world.entities.values()].find((item) => item.parent === serial && item.layer === layer);
  const holdsLight = (layer: number) => {
    const item = worn(layer);
    return !!item && layer === Layer.TwoHanded && (terrain.tile(item.graphic, true).flags & 0x800000) !== 0;
  };
  const wearLayer = (item: Entity) => {
    const tile = terrain.tile(item.graphic, true);
    return tile.flags & 0x400000 && !reserved.has(tile.layer) ? tile.layer : 0;
  };
  const refused = new Set<number>();
  // Returns whether the server confirmed the item worn.
  const wear = async (item: Entity, layer: number) => {
    try {
      await session.equipItem(item.serial, layer);
      log(`Wearing ${terrain.tile(item.graphic, true).name || item.graphic.toString(16)} on layer ${layer}`);
      return true;
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      // Unwearable gear is sold or banked with the loot rather than carried around.
      refused.add(item.graphic);
      if (!trip.loot.includes(item.serial)) trip.loot.push(item.serial);
      ctx.persist();
      log(`Server refused wearing item ${item.serial}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  // Durability from the property list: "durability ~1_val~ / ~2_val~" (BaseWeapon/BaseArmor 1060639).
  const wornOut = (item: Entity) => {
    const text = session.world.entities.get(item.serial)?.properties?.find((p) => p.cliloc === 1060639)?.arguments;
    const [hits, max] = (text ?? '').split('\t').map(Number);
    return !!max && hits !== undefined && (hits <= 3 || hits / max < WORN_SHARE);
  };
  // Serials retired for wear: sold with the loot, never re-equipped or counted as a usable weapon.
  const retired = new Set<number>();
  const strengthFor = (graphic: number) => {
    const name = terrain.tile(graphic, true).name;
    return armorFamilies.find(([pattern]) => pattern.test(name))?.[1];
  };

  // After resurrection: discard the death robe and put recovered personal gear back on.
  // Loot awaiting sale stays in the pack; weapons are handled by the sword equip step.
  const dress = async () => {
    const robe = worn(22);
    // Keep the robe when no recovered torso clothing or armor could replace it.
    const replacement = contents().some(
      (item) => [5, 13, 22].includes(wearLayer(item)) && item.graphic !== deathRobe && !trip.loot.includes(item.serial)
    );
    if (robe?.graphic === deathRobe && replacement) {
      phase('dressing', 'Discarding the death robe');
      await session.dropAtFeet(robe.serial);
    }
    // A candle or torch in the off hand gives way to a shield (tiledata LightSource).
    const light = holdsLight;
    for (const item of contents()) {
      check();
      const layer = wearLayer(item);
      if (!layer || weaponsFor(ctx.template).has(item.graphic) || item.graphic === deathRobe) continue;
      // Hands belong to the weapon step: the weapon hand never takes other families' weapons, and
      // the off hand only shields and light sources (two-handed weapons also use layer 2).
      const tile = terrain.tile(item.graphic, true);
      if (
        layer === Layer.OneHanded ||
        (layer === Layer.TwoHanded && !/shield|buckler/i.test(tile.name) && !(tile.flags & 0x800000))
      )
        continue;
      if (refused.has(item.graphic)) continue;
      const looted = trip.loot.includes(item.serial);
      // A candle or torch shares the shield layer but is not armor: never compared or sold.
      const isLight = (terrain.tile(item.graphic, true).flags & 0x800000) !== 0;
      if (armorLayers.has(layer) && !isLight) {
        await compareArmor(item, layer, light(layer));
        continue;
      }
      // Looted clothing stays for sale; personal clothing fills an empty slot.
      if (looted || worn(layer)) continue;
      await wear(item, layer);
      await Bun.sleep(600);
    }
    await compareWeapons();
    ctx.persist();
  };

  // Wields the best weapon of the fighter's own family it can carry; losing looted weapons are sold.
  const compareWeapons = async () => {
    const family = weaponsFor(ctx.template);
    const held = [1, 2].map(worn).find((item) => item && family.has(item.graphic));
    const shield = worn(2) && !family.has(worn(2)?.graphic ?? 0) && !holdsLight(2);
    const candidates = [...(held ? [held] : []), ...contents().filter((item) => family.has(item.graphic))];
    let best: { item: Entity; score: number } | undefined;
    for (const item of candidates) {
      if (retired.has(item.serial) || refused.has(item.graphic)) continue;
      const specs = await weaponSpecs(item);
      if (wornOut(item)) {
        retired.add(item.serial);
        if (item !== held) markForSale(item.serial);
        continue;
      }
      if (specs.strength > status().strength || (specs.twoHanded && shield && item !== held)) continue;
      if (!best || specs.score > best.score) best = { item, score: specs.score };
    }
    for (const item of candidates)
      if (item !== best?.item && item !== held && trip.loot.includes(item.serial)) markForSale(item.serial);
    if (!best || best.item === held) return;
    const layer = wearLayer(best.item) || Layer.OneHanded;
    if (held) await session.moveItem(held.serial, ctx.backpack());
    trip.loot = trip.loot.filter((serial) => serial !== best.item.serial);
    if (await wear(best.item, layer))
      log(
        `Wielding ${terrain.tile(best.item.graphic, true).name || 'a weapon'} (weapon score ${best.score.toFixed(1)})`
      );
  };
  // AOS weapon specs (BaseWeapon.GetProperties): average damage over swing seconds, scaled by
  // damage, hit chance and swing speed increases. SE+ lists speed in seconds ("2.75s").
  const weaponSpecs = async (item: Entity) => {
    try {
      await session.inspectProperties(item.serial);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
    }
    const properties = session.world.entities.get(item.serial)?.properties ?? [];
    const raw = (cliloc: number) => properties.find((p) => p.cliloc === cliloc)?.arguments ?? '';
    const value = (cliloc: number) => Number.parseFloat(raw(cliloc)) || 0;
    const [min, max] = raw(1061168)
      .split('\t')
      .map((n) => Number(n) || 0);
    const speedText = raw(1061167);
    const seconds = speedText.endsWith('s') ? Number.parseFloat(speedText) || 3 : 40 / (Number(speedText) || 13);
    const average = ((min ?? 0) + (max ?? 0)) / 2;
    const score =
      ((average * (1 + value(1060401) / 100) * (1 + value(1060415) / 100) * (1 + value(1060486) / 100)) / seconds) * 10;
    return { score, strength: value(1061170), twoHanded: properties.some((p) => p.cliloc === 1061171) };
  };

  // Keeps the better of a carried piece and the one worn in its slot; the other is marked for sale.
  // Casters wear only leather or studded leather (several pieces), never metal armor, and no shield:
  // ServUO refuses spells while the hands hold an item without spell channeling.
  const caster = !!ctx.template.archetype?.primarySkills.includes('Magery');
  const suits = (item: Entity, layer: number) => {
    if (!caster) return true;
    const name = terrain.tile(item.graphic, true).name;
    return (
      layer !== Layer.TwoHanded && /leather|studded/i.test(name) && !/plate|chain|ring|bone|metal|bronze/i.test(name)
    );
  };
  const compareArmor = async (item: Entity, layer: number, lightHeld: boolean) => {
    if (retired.has(item.serial) || !suits(item, layer)) {
      markForSale(item.serial);
      return;
    }
    const held = worn(layer);
    const candidate = await armorSpecs(item);
    if (wornOut(item)) {
      retired.add(item.serial);
      markForSale(item.serial);
      return;
    }
    const name = terrain.tile(item.graphic, true).name || item.graphic.toString(16);
    if (candidate.strength > status().strength) {
      // The server refuses armor above the wearer's strength. Keep pieces the archetype's rising
      // strength will reach soon; sell the rest.
      const target = ctx.template.archetype?.stats.str ?? 100;
      const soon = candidate.strength <= target && candidate.strength - status().strength <= 15;
      if (soon) trip.loot = trip.loot.filter((serial) => serial !== item.serial);
      else markForSale(item.serial);
      log(
        `${name} needs ${candidate.strength} strength (have ${status().strength}); ${soon ? 'keeping it until then' : 'selling it'}`
      );
      return;
    }
    const current = held && !lightHeld ? await armorSpecs(held) : { score: -1, strength: 0 };
    if (candidate.score <= current.score) {
      markForSale(item.serial);
      log(`${name} (score ${candidate.score}) is no better than the worn piece (${current.score}); selling it`);
      return;
    }
    if (held) await session.moveItem(held.serial, ctx.backpack());
    trip.loot = trip.loot.filter((serial) => serial !== item.serial);
    await wear(item, layer);
    // The replaced armor is sold; a candle or torch is personal kit and stays in the pack.
    if (held && !lightHeld && worn(layer)?.serial === item.serial) markForSale(held.serial);
    log(`Armor on layer ${layer}: score ${candidate.score} replaces ${Math.max(0, current.score)}`);
    await Bun.sleep(600);
  };
  const markForSale = (serial: number) => {
    if (!trip.loot.includes(serial)) trip.loot.push(serial);
  };
  // AOS armor specs from the object property list (BaseArmor): five resists, physical weighted for
  // graveyard undead, and the strength requirement the server enforces.
  const armorSpecs = async (item: Entity) => {
    try {
      await session.inspectProperties(item.serial);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
    }
    const value = (cliloc: number) =>
      Number(session.world.entities.get(item.serial)?.properties?.find((p) => p.cliloc === cliloc)?.arguments ?? 0) ||
      0;
    const score = value(1060448) * 1.5 + value(1060447) + value(1060445) + value(1060449) + value(1060446);
    return { score, strength: value(1061170) || (strengthFor(item.graphic) ?? 0) };
  };

  // With spare funds, fill empty armor slots from an ordinary blacksmith, one affordable piece each.
  const upgradeArmor = async () => {
    if (fundsStale(ctx.checkpoint)) return;
    const spendable = () => spendableGold(session, ctx.backpack(), ctx.checkpoint);
    // A candle, torch, or lantern (tiledata LightSource) in the off hand blocks no shield: Parry only
    // trains with a shield held, so the light goes into the pack when a shield arrives.
    const light = holdsLight;
    if (spendable() < ARMOR_RESERVE + 30) return;
    phase('armor-shopping', `Looking for armor upgrades with ${spendable()} gold available`);
    await navigate(ctx.home.one('blacksmith'), 5);
    for (const mobile of nearby()) {
      check();
      const before = session.world.received.get(0x74) ?? 0;
      if (!(await contextAction(mobile, 3006103))) continue;
      try {
        await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'armor vendor stock', 2500);
      } catch {
        check();
        continue;
      }
      // The shield comes first: it enables Parry training and blocks melee outright. A slot is
      // upgraded only when the offer's specs clearly beat the worn piece.
      for (const layer of [...armorLayers].sort((a, b) => Number(b === 2) - Number(a === 2))) {
        const offers = [...session.world.buyOffers.values()].flat().filter((entry) => {
          const item = session.world.entities.get(entry.serial);
          const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
          return (
            item &&
            stock?.parent === mobile.serial &&
            (item.amount ?? 0) > 0 &&
            wearLayer(item) === layer &&
            suits(item, layer) &&
            !refused.has(item.graphic) &&
            entry.price > 0 &&
            entry.price <= ARMOR_PIECE_LIMIT &&
            entry.price <= spendable() - ARMOR_RESERVE
          );
        });
        let best: { offer: (typeof offers)[number]; score: number } | undefined;
        for (const offer of offers) {
          const item = session.world.entities.get(offer.serial);
          if (!item) continue;
          const specs = await armorSpecs(item);
          if (specs.strength > status().strength) continue;
          if (!best || specs.score > best.score || (specs.score === best.score && offer.price < best.offer.price))
            best = { offer, score: specs.score };
        }
        const held = worn(layer);
        const current = held && !light(layer) && !retired.has(held.serial) ? (await armorSpecs(held)).score : -1;
        if (!best || best.score <= current + 1) continue;
        const { offer } = best;
        const graphic = session.world.entities.get(offer.serial)?.graphic ?? 0;
        const owned = new Set(contents().map((item) => item.serial));
        await approachVendor(ctx, mobile.serial);
        await chargedPurchase(ctx, offer.price, () =>
          session.purchaseItem(mobile.serial, offer.serial, ctx.backpack(), 1, ARMOR_PIECE_LIMIT)
        );
        const bought = contents().find((item) => !owned.has(item.serial));
        phase(
          'armor-purchased',
          `Bought ${terrain.tile(graphic, true).name} (score ${best.score}) for ${offer.price} gold`
        );
        if (held && retired.has(held.serial)) {
          await session.moveItem(held.serial, ctx.backpack());
          markForSale(held.serial);
        }
        if (bought) await compareArmor(bought, layer, light(layer));
        // Stock lists go stale after a purchase; reopen on the next visit rather than guess.
        return;
      }
    }
    log('No affordable armor upgrade was offered');
  };

  // Wearables stored in the bank that would fill an empty layer, one per layer, after a revival
  // or when the corpse could not be recovered. Death robes stay where they are.
  const fromBank = (items: Entity[]) => {
    const chosen = new Map<number, Entity>();
    for (const item of items) {
      const layer = wearLayer(item);
      if (!layer || worn(layer) || chosen.has(layer) || refused.has(item.graphic)) continue;
      if (weaponsFor(ctx.template).has(item.graphic) || item.graphic === deathRobe) continue;
      if (contents().some((owned) => wearLayer(owned) === layer)) continue;
      chosen.set(layer, item);
    }
    return [...chosen.values()];
  };

  // Retires worn-out pieces while funds can replace them: armor stays on until a replacement is
  // bought (upgradeArmor), the weapon goes to the pack so the replacement step buys a new one.
  const retireWorn = async () => {
    if (fundsStale(ctx.checkpoint) || spendableGold(session, ctx.backpack(), ctx.checkpoint) < REPLACEMENT_RESERVE)
      return;
    for (const layer of [1, 2, ...armorLayers]) {
      const item = worn(layer);
      if (!item || retired.has(item.serial) || holdsLight(layer)) continue;
      await session.inspectProperties(item.serial).catch((error) => {
        if (session.phase !== 'ready') throw error;
      });
      if (!wornOut(item)) continue;
      retired.add(item.serial);
      markForSale(item.serial);
      const name = terrain.tile(item.graphic, true).name || item.graphic.toString(16);
      phase('retiring-worn-gear', `${name} is nearly broken; replacing it`);
      if (weaponsFor(ctx.template).has(item.graphic)) await session.moveItem(item.serial, ctx.backpack());
    }
    ctx.persist();
  };

  return { dress, upgradeArmor, fromBank, retireWorn, retired, refused };
}
