import { graphicOf, graphicsOf, shopPrices } from '@gemwright/common/game/rules';
import type { Entity } from '@gemwright/network/world';

import { quality } from './item-quality';
import type { ServiceType } from './locations';

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
// A good of ServUO types: the band runs from what shops pay for a middling piece of them to the most
// the cheapest shop charges for one.
function good(
  types: readonly string[],
  trade: { market: string; shop: ServiceType; lot: number },
  more: Pick<GoodDef, 'exceptional' | 'recipes'> = {}
): GoodDef {
  const prices = types.map(shopPrices);
  const graphics = types.flatMap(graphicsOf);
  return {
    graphic: graphicOf(types[0] ?? ''),
    ...(types.length > 1 && { graphics }),
    ...more,
    shopPays: prices.map((p) => p.pays).sort((a, b) => a - b)[Math.floor((prices.length - 1) / 2)] ?? 0,
    shopCharges: Math.max(...prices.map((p) => p.charges)),
    ...trade
  };
}
const armour = ['Ringmail', 'Chain', 'Plate'].flatMap((metal) =>
  ['Chest', 'Legs', 'Arms', 'Gloves', 'Coif', 'Gorget', 'Helm'].map((piece) => `${metal}${piece}`)
);
export const goods: Record<Good, GoodDef> = {
  // A smith's exceptional armour for fighters (SBPlateArmor, SBChainmailArmor, SBRingmailArmor).
  'exceptional armour': good(
    armour.filter((type) => graphicsOf(type).length),
    { market: 'minoc', shop: 'blacksmith', lot: 1 },
    { exceptional: true }
  ),
  arrows: good(['Arrow'], { market: 'britain', shop: 'bowyer', lot: 10 }),
  bolts: good(['Bolt'], { market: 'britain', shop: 'bowyer', lot: 10 }),
  cloth: good(['Cloth'], { market: 'britain', shop: 'tailor', lot: 10 }),
  bandages: good(['Bandage'], { market: 'britain', shop: 'healer', lot: 10 }),
  boards: good(['Board'], { market: 'yew', shop: 'carpenter', lot: 10 }),
  'heal potions': good(['LesserHealPotion'], { market: 'britain', shop: 'alchemist', lot: 2 }),
  'cure potions': good(['LesserCurePotion'], { market: 'britain', shop: 'alchemist', lot: 2 }),
  'poison potions': good(['LesserPoisonPotion'], { market: 'britain', shop: 'alchemist', lot: 2 }),
  // Minoc is the miners' town.
  'iron ingots': good(['IronIngot'], { market: 'minoc', shop: 'blacksmith', lot: 10 }),
  // A bowyer's exceptional bows and composite bows (item-quality.ts) for archers; what the bowyer
  // makes for it, best first; normal results go to the shop.
  'exceptional bows': good(
    ['Bow', 'CompositeBow'],
    { market: 'yew', shop: 'bowyer', lot: 1 },
    { exceptional: true, recipes: ['composite bow', 'bow'] }
  )
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
