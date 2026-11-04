import { graphicsOf, harvestOf, npcTypes, sells } from '@gemwright/common/game/rules';
import rules from '@gemwright/common/game/rules.json';

// Harvest tools from the ServUO rules (@gemwright/common/game/rules): every class that works a
// harvest system, by the graphics it shows, and the ones vendors sell.
export type Harvest = 'mining' | 'lumberjacking' | 'fishing';

const toolClasses = Object.keys(rules.classes).filter((name) => harvestOf(name));

// Every graphic a tool of this kind of work shows (both ways a flipable one faces).
export const harvestTools = (harvest: Harvest): ReadonlySet<number> =>
  new Set(toolClasses.filter((name) => harvestOf(name) === harvest).flatMap((name) => graphicsOf(name)));

// The tools of this kind of work some vendor sells, cheapest first: what a resident asks a shop for.
export function toolsForSale(harvest: Harvest): number[] {
  const price = new Map<number, number>();
  for (const npc of npcTypes)
    for (const offer of sells(npc))
      if (harvestOf(offer.type) === harvest)
        price.set(offer.graphic, Math.min(price.get(offer.graphic) ?? offer.price, offer.price));
  return [...price].sort((a, b) => a[1] - b[1]).map(([graphic]) => graphic);
}

export const miningTools = harvestTools('mining');
export const hatchets = harvestTools('lumberjacking');
export const fishingPoles = harvestTools('fishing');
