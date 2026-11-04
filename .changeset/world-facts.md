---
"@gemwright/common": minor
"@gemwright/ai": minor
"@gemwright/cli": minor
"@gemwright/analyze": patch
---

@gemwright/common holds the shard's structured facts in one place: every ServUO creature's stats, aggression, AI and taming (`game/creatures.json`, from the scripts, including what a creature inherits from its base), every facet's regions (`game/regions`), what each land tile is (`game/land`: water, grass, sand, rock, cave, road and the rest, from tiledata and the ServUO rules) and the world save reader (`saves`, RunUO and ServUO binary saves; Sphere saves are recognised but not read yet). AI residents share these instead of separate catalogues and per-resident guesses, and `gemwright deploy --ai --world <path>` also takes the forges, ankhs, spinning wheels and looms really standing in the world from the save.
