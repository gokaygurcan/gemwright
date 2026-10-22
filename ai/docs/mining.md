# Mining

[Documentation index](README.md)

The miner (`miner.ts`, with `miner-sites.ts`, `miner-travel.ts`, `miner-services.ts`, `miner-crafting.ts`, `miner-selling.ts`, `miner-pastimes.ts`) lives in Minoc and works the mining district around (2560, 500). Its loop is **mine → smelt → mine again → … → bank ingots**, with variety per trip.

```sh
bun run ai/src/index.ts session --config <population.json> --connection <connection.json> \
  --resident <miner-id> --miner-assets <assets> --duration 900
```

The assets directory holds the shard's public client files: `map1LegacyMUL.uop`, `staidx1.mul`, `statics1.mul` and `tiledata.mul` (64-bit format). `terrain.ts` reads the Trammel map, statics, surfaces and collision flags, using corner heights on sloped land.

## A trip

- **Plan.** A new trip samples how many smelting visits come before banking (one 20%, two 55%, three 20%, four 5%) and its thresholds: with `bankAtWeightRatio` 0.8, smelting starts at 64–80% of carrying capacity and banking at 72–80%. Mining always keeps 30 weight units free; at most 110 pack items are allowed. The plan is saved in the checkpoint, so a restart continues the same trip.
- **Mine.** Sites are mountain land, walkable cave land and real cave-floor statics (`0x053B–0x054F`); server replies decide success, depletion, invalid targets and line-of-sight failures. Mountain approaches stand one tile off (90%) or two (10%); cave floors are stood on (80%) or beside (20%). Depleted spots and vein blocks are remembered for 20 minutes (the longest ServUO ore respawn) across restarts; a spot navigation cannot reach is skipped the same way, and more than eight unreachable spots in a row is a setback.
- **Smelt.** Forges come from observed items and the public static map. The miner stands on a cardinal side of the forge (a diagonal behind a window can block the sightline), falls back to the two-tile ring when a side is occupied, double-clicks an ore pile and targets the forge with the live cursor. Success needs a higher ingot count; a known failure needs changed ore before retrying. Ore too hard to smelt and lone fragments stay carried. Observed forges are remembered per region.
- **Bank.** Ingots (`0x1BF2`) go to the bank by ordinary lift and drop, confirmed by the server. Raw ore is never banked.
- **Restock.** A stocked mining tool of at most 100 gold is bought when none is carried; vendors charge carried gold and then the bank balance ([funds](funds.md)). A miner with one tool left keeps mining; without any it records a `missing-tool` or `insufficient-funds` setback.

When the bank holds plenty of ingots, the miner smiths shields at a forge and anvil for profit or sells surplus ingots to the Minoc blacksmith (`miner-crafting.ts`, `miner-selling.ts`). Short of banked iron, it buys ingots from the blacksmith (5 gold each, SBBlacksmith) when its best recipe earns more than that per ingot. An exceptional piece (1044155, or 1044156 with the maker's mark) is never sold: it is kept in the checkpoint's `keep` list and deposited on the next bank trip; other crafters (`craft-training.ts`) bank theirs right after selling. In quiet moments it trains supporting skills ([skill usage](skill-usage.md)). With Jev, the next activity is a `mining-activity` decision.

## Movement

Routing prefers recognizable paths: road terrain costs less, a clearance scan keeps to the middle of roads, and walls, water edges and drops add cost. Turns cost a little; no random wandering is added. Observed solid items and mobiles are avoided; doors and other surprises use server movement feedback, and a step rejection only blocks a tile for the current route.

The client sets the run bit away from interactions while stamina is at least 35% and weight under 95% of capacity, slows for the last three tiles, and rests (at most 45 seconds) at 15% stamina or three points. Running steps are paced at 210–230 ms plus the acknowledgement round trip, walking at 390–430 ms. Miners ride a horse when they own one, dismounting to mine ([mounts](mounts.md)).

## Recovery

Phases and short observations are saved through the revision-checked checkpoint. A new process decides from current inventory, status and the saved trip plan; pending forge or bank travel resumes from current observations. Uncertain lift, drop and purchase requests are never replayed ([reconnect](reconnect.md)).
