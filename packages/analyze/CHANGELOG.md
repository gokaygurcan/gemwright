# @gemwright/analyze

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn where vendors stand and creatures spawn, in towns, on Haven Island and overland, from the shard's own world files (Spawns/*.xml and Regions.xml), which `gemwright deploy --ai` keeps on the AI volume and replaces only when they change; `--world <path>` and `--world-pull` teach them from a world save instead, with whatever was placed or changed in game; a fighter skips any ground with a creature that attacks on sight it is not ready for.

### Patch Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common holds the shard's structured facts in one place: every ServUO creature's stats, aggression, AI and taming (`game/creatures.json`, from the scripts, including what a creature inherits from its base), every facet's regions (`game/regions`), what each land tile is (`game/land`: water, grass, sand, rock, cave, road and the rest, from tiledata and the ServUO rules) and the world save reader (`saves`, RunUO and ServUO binary saves; Sphere saves are recognised but not read yet). AI residents share these instead of separate catalogues and per-resident guesses, and `gemwright deploy --ai --world <path>` also takes the forges, ankhs, spinning wheels and looms really standing in the world from the save.

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
