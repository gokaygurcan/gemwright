import { quality } from './item-quality';
import type { ServiceType } from './locations';
import type { Entity } from './protocol/world';

// What residents trade with each other (market.ts), and for each good the NPC shop's buying and
// selling prices that bound every deal, the town that trades it and the smallest lot worth a trip.
export type Good =
  | 'boards'
  | 'heal potions'
  | 'cure potions'
  | 'poison potions'
  | 'iron ingots'
  | 'exceptional bows'
  | 'arrows'
  | 'bolts'
  | 'cloth'
  | 'bandages'
  | 'exceptional armour';
interface GoodDef {
  graphic: number;
  // Several graphics for one good (bow and composite bow); `graphic` alone otherwise.
  graphics?: readonly number[];
  // Only exceptional pieces count (item-quality.ts).
  exceptional?: boolean;
  // What a crafter makes for it, best first.
  recipes?: readonly string[];
  shopPays: number;
  shopCharges: number;
  market: string;
  shop: ServiceType;
  lot: number;
}
export const goods: Record<Good, GoodDef> = {
  // A smith's exceptional armour for fighters. The armourer pays about half its price back
  // (SBPlateArmor, SBChainmailArmor, SBRingmailArmor), so the band runs between the two.
  'exceptional armour': {
    graphic: 0x1415,
    graphics: [
      0x13ec, // ringmail tunic
      0x13f0, // ringmail leggings
      0x13ee, // ringmail sleeves
      0x13eb, // ringmail gloves
      0x13bf, // chainmail tunic
      0x13be, // chainmail leggings
      0x13bb, // chainmail coif
      0x1415, // platemail tunic
      0x1411, // platemail legs
      0x1410, // platemail arms
      0x1413, // plate gorget
      0x1414, // platemail gloves
      0x1412 // plate helm
    ],
    exceptional: true,
    shopPays: 60,
    shopCharges: 243,
    market: 'minoc',
    shop: 'blacksmith',
    lot: 1
  },
  arrows: { graphic: 0x0f3f, shopPays: 1, shopCharges: 3, market: 'britain', shop: 'bowyer', lot: 10 },
  bolts: { graphic: 0x1bfb, shopPays: 1, shopCharges: 3, market: 'britain', shop: 'bowyer', lot: 10 },
  cloth: { graphic: 0x1766, shopPays: 1, shopCharges: 2, market: 'britain', shop: 'tailor', lot: 10 },
  bandages: { graphic: 0x0e21, shopPays: 1, shopCharges: 5, market: 'britain', shop: 'healer', lot: 10 },
  boards: { graphic: 0x1bd7, shopPays: 2, shopCharges: 3, market: 'yew', shop: 'carpenter', lot: 10 },
  'heal potions': { graphic: 0x0f0c, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  'cure potions': { graphic: 0x0f07, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  'poison potions': { graphic: 0x0f0a, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  // SBBlacksmith: sells iron at 5 (only 16 in stock), buys at 4; Minoc is the miners' town.
  'iron ingots': { graphic: 0x1bf2, shopPays: 4, shopCharges: 5, market: 'minoc', shop: 'blacksmith', lot: 10 },
  // A bowyer's exceptional bows and composite bows (item-quality.ts) for archers. Shops buy any bow
  // back for at most 27 (SBRangedWeapon), so the band starts above that and runs to 80.
  'exceptional bows': {
    graphic: 0x13b2,
    graphics: [0x13b2, 0x26c2],
    exceptional: true,
    // What the bowyer makes for it, best first; normal results go to the shop.
    recipes: ['composite bow', 'bow'],
    shopPays: 27,
    shopCharges: 81,
    market: 'yew',
    shop: 'bowyer',
    lot: 1
  }
};

// The items a good covers: plain (unhued) ones of its graphics, and only exceptional ones when so.
export const goodMatch = (good: Good) => {
  const def = goods[good];
  const graphics = def.graphics ?? [def.graphic];
  return (item: Entity) =>
    graphics.includes(item.graphic) &&
    (!item.hue || good === 'cloth') &&
    (!def.exceptional || quality(item) === 'exceptional');
};
