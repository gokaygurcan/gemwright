import { LAYERS } from '@gemwright/common/layers';

import type { Item, Mobile, World } from './world';

// Who holds each item and where: an item's parent chain ends either at a mobile (its holder) or
// at an item lying in the world. The first step below the mobile says how it is held.
export type Place =
  | 'worn' // equipped, or inside something equipped (a quiver)
  | 'backpack'
  | 'bank'
  | 'vendor stock' // a vendor's buy, resale or sell layers
  | 'mount' // the mount item of a ridden animal
  | 'ground' // lying in the world
  | 'ground container' // inside a container lying in the world (house boxes, corpses)
  | 'internal' // on the internal map, outside the world
  | 'orphan'; // its parent is not in the save

export interface Placement {
  item: Item;
  holder?: Mobile;
  place: Place;
  // The containers from the outermost down to the item's own parent.
  path: Item[];
  // Where the outermost item lies, for items not held by a mobile.
  where?: { map: number; x: number; y: number };
}

const SHOP: number[] = [LAYERS.shopBuy, LAYERS.shopResale, LAYERS.shopSell];

export function placeItems(world: World): Map<number, Placement> {
  const placed = new Map<number, Placement>();
  const place = (item: Item): Placement => {
    const known = placed.get(item.serial);
    if (known) return known;
    let result: Placement;
    if (item.parent === undefined) {
      const where = { map: item.map, x: item.location.x, y: item.location.y };
      result = { item, place: item.map === 0x7f ? 'internal' : 'ground', path: [], where };
    } else {
      const holder = world.mobiles.get(item.parent);
      const container = world.items.get(item.parent);
      if (holder) {
        const layer = item.layer;
        const how: Place =
          layer === LAYERS.bank
            ? 'bank'
            : layer === LAYERS.backpack
              ? 'backpack'
              : SHOP.includes(layer)
                ? 'vendor stock'
                : layer === LAYERS.mount
                  ? 'mount'
                  : 'worn';
        result = { item, holder, place: how, path: [] };
      } else if (container) {
        const outer = place(container);
        const how: Place =
          outer.place === 'ground' ? 'ground container' : outer.place === 'orphan' ? 'orphan' : outer.place;
        result = { ...outer, item, place: how, path: [...outer.path, container] };
      } else result = { item, place: 'orphan', path: [] };
    }
    placed.set(item.serial, result);
    return result;
  };
  for (const item of world.items.values()) place(item);
  return placed;
}

// Whose items they are: residents (AI accounts), other players, or creatures and vendors.
export type HolderKind = 'resident' | 'player' | 'creature' | 'none';
export function holderKind(holder: Mobile | undefined, residents: Set<number>): HolderKind {
  if (!holder) return 'none';
  if (residents.has(holder.serial)) return 'resident';
  return holder.player ? 'player' : 'creature';
}

// What an item is called in a listing: its own name, else its script type.
export const itemLabel = (item: Item) => item.name ?? item.type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');
