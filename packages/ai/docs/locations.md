# Locations

[Documentation index](README.md)

`packages/ai/locations/locations.json` is the place catalog: named places by city and region. A name and coordinates alone do not identify a vendor, its stock or a safe route.

Navigation covers Trammel (facet 1). Shops come from `services-guide.json`, generated from ServUO's town-guide data; `services.json` maps a city and service type to catalog names where the guide lacks or misplaces one. New Haven has its own catalog, `new-haven.json`, built from ServUO's regions and spawners (`src/build-new-haven.ts`).

The loader in `packages/ai/src/locations.ts` resolves exact names, validates coordinates, and returns immutable landmarks. Missing or ambiguous references fail explicitly. A town without a service (Yew has no bank or blacksmith) falls back to Britain's, or to the nearest town that has one.

Where residents can actually walk is `areas.json`, built from the client map by `build-areas.ts`: known places grouped into areas that walks and teleporters join. A place is chosen only in the resident's own area, or in another one when both have a moongate ([population](population.md#how-residents-decide)).

## Using a landmark

A landmark guides travel to an area. It does not supply NPC serials, hidden positions, inventories, prices, or authority to interact through an obstruction. On arrival the character still discovers the relevant mobile through received entities and offered context actions. A catalog name such as an alchemist's shop is a search hint; only current offered stock determines whether potions can be bought there.

Every behavior uses these landmarks for its town business: healers, supplies, sales, banking, tools and mounts. A landmark is verified against the NPC actually observed there.

`mobile-approach.ts` chooses a reachable cardinal tile beside an observed mobile on the same floor. It checks static walls/windows and observed solid items, refuses diagonal corner interactions, and navigates to the exact tile with the shared door-aware navigator. If the NPC moves, the approach is recomputed. Purchases and sales check the approach again before execution. An unreachable service is a bounded failure; a menu that can be queried from afar is not permission to trade through a wall.

## Stairs and doors

Terrain follows ServUO's `Movement.cs`: a stair or bridge has a base, a standing height and a full top height. Stepping onto one checks its base against the step allowance, and its top height permits the move onto the floor beyond. At Britain's Ethereal Goods, for example, the street is Z=20, the stairs at (1508, 1658) have base 22 and height 5, and the shop floor is Z=27. Solid objects that are not stairs or bridges get no such allowance.

Closed observed doors remain normal item interactions: the navigator follows the reachable terrain route, opens a nearby relevant door when it blocks movement, and requires server movement acknowledgement before continuing. It does not teleport, ignore server corrections, or treat walls as doors. Full multi/custom-house navigation remains outside the current supported geometry.

Related: [sessions](sessions.md).
