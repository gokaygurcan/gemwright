# @gemwright/ai

## 0.11.0

### Minor Changes

- AI residents log every decision question with its request, the answer, and the exact body sent to and received from Clef and Jev, kept for a week.

### Patch Changes

- AI bards skip creatures their songs cannot affect for a while, and loot the coins of provoked fights before starting the next.

- AI residents write their checkpoint at most every five seconds, keeping the event loop free so walking stays smooth.

- AI residents put the death robe into their pack when changing into their own robe, and log why a death robe stays on.

- AI fighters buy only weapons their race can wield, spend what they have on one, and hunt bare-handed when none can be had instead of waiting in town.

- AI miners leave stretches of empty ore veins instead of trying every block next door.

- AI residents try mounting again after the shard's action delay instead of giving up.

- AI residents ride a horse from any adjacent tile, diagonals included, and chase a following horse that steps away.

- AI residents accept map files mounted by Docker deployments, and a restored retired list replaces the current one with the resident database.

- AI residents walk past ground where they were attacked lately when nothing is in sight, and recover their height from the shard when no route can start from it.

- AI residents swap the death robe for a robe of their own in the pack at the next turn, not at the next bank visit.

- Clef and Jev decisions spread their daily allowance across the UTC day instead of spending it at the first opportunity.

- AI residents step at an even pace; work between steps no longer adds a pause after each one.

- AI residents log unexpected bank balance changes, why an errand gained nothing, and why a hunt found no opponent.

- AI residents wait on the road for pets that fall behind, including a tamer's animals on offer.

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents remember a vendor, healer, escort, tamable animals or hunting ground they went for and did not find, for a while (longer after a second miss, and never for ever), so a dead wandering healer or an emptied ground is not sought again at once; hold times are in tuning.json.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn which places can be walked to from which from the shard's own world and map, building it once (about a minute) and keeping it on the data volume until either changes.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - `ai.cities` in gemwright.json names the only cities AI residents go to: their shops, banks, healers and moongates, and the hunting grounds around them. A resident living elsewhere works from the nearest allowed town.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents find Haven Island, spinning wheels, looms and sheep pastures in the shard's world files, and each town's mines and woods on the map; the public roads they follow on long walks are walked once at start and kept on the data volume until the towns or the map change. The AI image no longer carries hand-made location files.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents know harvest tools from the ServUO rules: a tool is whatever ServUO lets do that work, facing either way, and a missing one is bought as the cheapest any vendor there sells. The hand-written tool lists are gone from @gemwright/common.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn where vendors stand and creatures spawn, in towns, on Haven Island and overland, from the shard's own world files (Spawns/*.xml and Regions.xml), which `gemwright deploy --ai` keeps on the AI volume and replaces only when they change; `--world <path>` and `--world-pull` teach them from a world save instead, with whatever was placed or changed in game; a fighter skips any ground with a creature that attacks on sight it is not ready for.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI tamers and escort seekers learn where tamable animals and escorts may appear from the shard's own spawners, and look for them only around the allowed cities.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common carries the ServUO rules (`game/rules.json`, generated from the pinned ServUO's scripts): item graphics and what vendors sell and buy, races and their looks, skills, maps, harvest tiles and ores, doors, spell scrolls and mana, crafting tools and stations. AI residents read every item, tool, spell, door and station from it instead of hand-written lists, which also gives gargoyles the hair styles of their own sex and the right scrolls for Arch Protection, Magic Reflection and Reveal.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common holds the shard's structured facts in one place: every ServUO creature's stats, aggression, AI and taming (`game/creatures.json`, from the scripts, including what a creature inherits from its base), every facet's regions (`game/regions`), what each land tile is (`game/land`: water, grass, sand, rock, cave, road and the rest, from tiledata and the ServUO rules) and the world save reader (`saves`, RunUO and ServUO binary saves; Sphere saves are recognised but not read yet). AI residents share these instead of separate catalogues and per-resident guesses, and `gemwright deploy --ai --world <path>` also takes the forges, ankhs, spinning wheels and looms really standing in the world from the save.

### Patch Changes

- [`805665c`](https://github.com/gokaygurcan/gemwright/commit/805665c024361e9aebe31d092bf23c306ec5404d) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents walk around ground where residents died twice in the last six hours instead of through it.

- [`5e27139`](https://github.com/gokaygurcan/gemwright/commit/5e27139e7348526ce5ba6e2c888e6733085f6c33) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents no longer take another resident's banker balance reply as their own.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn which creatures cannot reach them, as players do: one that attacks on sight but stays put close by for half a minute without coming nearer (the caged animals of Moonglow's zoo) is no longer counted as a danger, until it moves closer or swings at someone.

- [`805665c`](https://github.com/gokaygurcan/gemwright/commit/805665c024361e9aebe31d092bf23c306ec5404d) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - A ghost tries far healers whose walk from the moongate crosses where residents died recently last, so it no longer rises on the wrong side of the danger.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI ghosts walk the straightest way to resurrection: over creatures, through doors, with no roads to favour and no danger to avoid.

- [`10db580`](https://github.com/gokaygurcan/gemwright/commit/10db5806bdf7fa4a3970d4b979ba0297a282f5b3) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Graveyards list only their own spawner's undead, so novices hunt the Britain graveyard again; a fighter not ready for a lich no longer picks a ground with one, such as Cove's.

- [`805665c`](https://github.com/gokaygurcan/gemwright/commit/805665c024361e9aebe31d092bf23c306ec5404d) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents rest after a resurrection until most of their health is back, up to fifteen minutes, instead of leaving at a third of it.

- [`7d0b762`](https://github.com/gokaygurcan/gemwright/commit/7d0b76216e0b0f70c914576e48e714836040c678) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI miners no longer buy pack animals or search for lost ones; one they already have still carries ore.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents buy a missing work tool in one visit to their town's vendor, whichever kind it sells (a miner's pickaxe is sold as 0xE86), instead of touring other towns for one particular graphic. Miners return to a far mining district through its moongate instead of walking across the land.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents know every Trammel teleporter, dungeon and mine ones included, and learn each dungeon's levels and their way out from the shard's world files and map. Anyone inside a dungeon, a ghost above all, first goes up level by level and out to the open world before going anywhere else; one standing on a teleporter steps off and back on, as the server only sends who steps onto it. An ankh is taken for missing only when its spot is in plain view and empty, and then for good.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents no longer stand still for good when securing their goods cannot lower a small risk: once recovery has been tried in the same situation, a healthy, unthreatened resident goes back to work, and recovery away from home walks back to its town's bank first. Ghosts look for healers only where a spawner keeps one, not at wildlife spawners a wandering healer roams from, and the AI world files no longer need a town guide.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents leave behind any plain piece no shop took on a second trip, not only pieces marked for sale.

- [`1829988`](https://github.com/gokaygurcan/gemwright/commit/18299881a4fa7bdfec6ffb5b98578609360e1be0) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents leave behind a piece no shop buys after a second unsold trip instead of carrying it on selling trips indefinitely.

## 0.9.0

### Patch Changes

- AI residents walk by `map1.mul` when the game files have no `map1LegacyMUL.uop`, including the narrower pre-expansion Trammel.

- Update the AI and web client log export to OpenTelemetry 3 (`sdk-logs` and `resources` 3.0.0, `exporter-logs-otlp-http` 0.300.0).

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Split the Node-compatible CLI from the gemwright wrapper and deliver contained Bun AI/client runtimes. Add explicit schema-version compatibility, exact service package selection and independent Railway service updates with persistent resource preservation. Align private workspace versions through the shared Changesets group and make partial publication and release-metadata retries resumable.
