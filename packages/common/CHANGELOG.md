# @gemwright/common

## 0.11.0

### Minor Changes

- `gemwright.json` records the deployment target and a `vps` block with the SSH destination, port, path, public host and browser-client domain.

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - `ai.cities` in gemwright.json names the only cities AI residents go to: their shops, banks, healers and moongates, and the hunting grounds around them. A resident living elsewhere works from the nearest allowed town.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents know harvest tools from the ServUO rules: a tool is whatever ServUO lets do that work, facing either way, and a missing one is bought as the cheapest any vendor there sells. The hand-written tool lists are gone from @gemwright/common.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common carries the ServUO rules (`game/rules.json`, generated from the pinned ServUO's scripts): item graphics and what vendors sell and buy, races and their looks, skills, maps, harvest tiles and ores, doors, spell scrolls and mana, crafting tools and stations. AI residents read every item, tool, spell, door and station from it instead of hand-written lists, which also gives gargoyles the hair styles of their own sex and the right scrolls for Arch Protection, Magic Reflection and Reveal.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common holds the shard's structured facts in one place: every ServUO creature's stats, aggression, AI and taming (`game/creatures.json`, from the scripts, including what a creature inherits from its base), every facet's regions (`game/regions`), what each land tile is (`game/land`: water, grass, sand, rock, cave, road and the rest, from tiledata and the ServUO rules) and the world save reader (`saves`, RunUO and ServUO binary saves; Sphere saves are recognised but not read yet). AI residents share these instead of separate catalogues and per-resident guesses, and `gemwright deploy --ai --world <path>` also takes the forges, ankhs, spinning wheels and looms really standing in the world from the save.

### Patch Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents no longer stand still for good when securing their goods cannot lower a small risk: once recovery has been tried in the same situation, a healthy, unthreatened resident goes back to work, and recovery away from home walks back to its town's bank first. Ghosts look for healers only where a spawner keeps one, not at wildlife spawners a wandering healer roams from, and the AI world files no longer need a town guide.

## 0.9.0

### Minor Changes

- The save browser draws item art (ridden ethereals as their statuettes), picks paperdoll items by pixel, and has a world map from the client's radar colours with residents, players, houses, failed walks and deaths on top. The overview shows the shard's last day: headline numbers against the previous pull, residents online and their wealth over time, what they spent the day doing, who needs a look, the top earners and losers, and where residents are. The web app is styled with Tailwind, and `--shard` (or `bun run analyze --shard <folder>` from the repository root) picks the shard folder.

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

No changes in this release.
