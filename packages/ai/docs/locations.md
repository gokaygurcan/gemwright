# Locations

[Documentation index](README.md)

Navigation supports Trammel. `locations/locations.json` names places; `services-guide.json`, `services.json` and `cobblers.json` identify service destinations. New Haven has `new-haven.json`. `locations.ts` validates references and resolves service fallbacks. Catalog coordinates guide discovery; actual observed NPCs, offered menus and stock determine available interactions.

## Islands and dungeons

`areas.json` groups places by walkable connectivity. `journey.ts` chooses walking legs, reachable public moongates or valid marked Recall destinations. A destination gate must serve the destination's land area, not merely be nearby across water. Approaching a gate remains a walking leg.

Jhelom's teleporters connect its islands; mainland trips require a moongate or Recall. Failed taming-ground trips temporarily exclude that destination.

Dungeon interiors use catalogued entrances and stair links. `dungeonAt` identifies the nearest matching section. `dungeon-tools.ts` follows the graph to enter, change floors and return to the surface, including equal-depth links. Missing routes fail explicitly.

## Remembered smithing stations

`smithing-stations.ts` discovers received world fixtures and client statics. Crafting needs a reachable standing tile within two tiles of both an anvil and forge at compatible heights. Known smelting forges and blacksmith shops provide search destinations.

Up to sixteen pairs are remembered in `checkpoint.landmarks.smithies`, revalidated on return and excluded for ten minutes after server rejection. Material refills precede the station check. Minoc's mine-entrance pair at (2560,501) and (2561,501), and shop fixtures, are server objects; statics alone are insufficient.

## Approaches and movement

`mobile-approach.ts` finds a reachable cardinal tile beside an observed NPC on the same floor, checks walls and solid objects, and rechecks when it moves. Purchases and sales require a valid approach.

Terrain follows ServUO stair/bridge heights. The navigator opens observed doors and requires movement acknowledgement; server corrections win. Full multi/custom-house geometry is unsupported.
