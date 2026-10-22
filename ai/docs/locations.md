# Locations

[Documentation index](README.md)

`ai/locations/locations.json` is the original place catalog. It contains 289 named places across 35 city/region keys, including empty lists. Names and coordinates alone do not identify a vendor or establish a facet, service, current stock, or safe route.

`ai/locations/services.json` is a small, explicit mapping from city and service type to catalog names. The current navigation profile is Trammel (facet 1). It maps Britain and Minoc explicitly; other cities' shops come from `services-guide.json`, generated from ServUO's town-guide data.

The loader in `ai/src/locations.ts` resolves exact names, validates coordinates, and returns immutable landmarks. Missing or ambiguous references fail explicitly. Services currently cover bankers, healers, alchemists, tailors, blacksmiths, jewelers, mining-tool shops, animal trainers, and the Britain graveyard. The supplied Minoc list is empty, so the already established Minoc bank/tool-shop approach coordinates remain explicit entries in the service mapping rather than being silently invented in the original catalog.

## Using a landmark

A landmark guides travel to an area. It does not supply NPC serials, hidden positions, inventories, prices, or authority to interact through an obstruction. On arrival the character still discovers the relevant mobile through received entities and offered context actions. A catalog name such as an alchemist's shop is a search hint; only current offered stock determines whether potions can be bought there.

The fighter uses this mapping for healer travel, supplies, weapon replacement, sales, banking, and the graveyard destination. The miner uses it for banker and tool-shop approaches. Both behaviors also use animal-trainer landmarks for [mount purchases](mounts.md); Minoc's stable hint comes from the pinned public Trammel spawn template and is verified against an observed trainer at runtime. Its processing and town services now live in `miner-services.ts`, keeping the behavior files below the root size limit.

`mobile-approach.ts` chooses a reachable cardinal tile beside an observed mobile on the same floor. It checks static walls/windows and observed solid items, refuses diagonal corner interactions, and navigates to the exact tile with the shared door-aware navigator. If the NPC moves, the approach is recomputed. Purchases and sales check the approach again before execution. An unreachable service is a bounded failure; a menu that can be queried from afar is not permission to trade through a wall.

## Stairs and doors

The public client assets and ServUO's `Scripts/Services/Pathing/Movement.cs` exposed a concrete elevation bug. At Britain's Ethereal Goods, the street is Z=20, stone stairs at `(1508, 1658)` have base Z=22 and height 5, and the shop floor is Z=27. The old client required the final standing height to remain within two units, so it could never use this valid entrance.

The corrected terrain calculation follows ServUO's distinction between a bridge/stair's base, calculated standing height, and full top height. Entering that stair checks its base against the step allowance and produces Z=24. Its full top height then permits the move onto the Z=27 floor. The actual asset calculation now finds an eleven-step route from the nearby street to the shop interior. Solid non-bridge objects do not gain the same allowance.

Closed observed doors remain normal item interactions: the navigator follows the reachable terrain route, opens a nearby relevant door when it blocks movement, and requires server movement acknowledgement before continuing. It does not teleport, ignore server corrections, or treat walls as doors. Full multi/custom-house navigation remains outside the current supported geometry.

Minoc's blacksmith landmark (2471, 564) comes from the pinned Trammel spawner, where the miner sells surplus iron ingots.

Related: [sessions](sessions.md) · [mining](mining.md) · [fighter](fighter.md).
