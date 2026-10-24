# Running a population

[Documentation index](README.md)

```sh
bun run packages/ai/src/index.ts population --config <population.json> --connection <connection.json> \
  --assets <dir> --duration <seconds> [--shard <gemwright.json>] [--decisions <decisions.json>]
```

`run-population.ts` runs every desired-active resident in one process. The shard lease (`ownership.ts`) admits one runtime per shard, so one process holds it for the whole population. Each resident gets its own session, reconnect budget and behavior supervision (`runResident` in `run-session.ts`). A template's activities choose its behavior: miner, lumberjack, fighter, or a profession (tamer, thief, bard, fisher, tailor) run by `profession.ts`.

- Logins are staggered (`--stagger`, default 20 seconds); `--limit` runs only the first N residents.
- One resident's failure never stops the others; log lines carry the resident's name.
- The run writes `proofs/population-latest.json`: each resident's outcome, temperament, funds, mount state, decision tallies, peers seen, recent memories, and the maximum event-loop lag.

## Development runs from this machine

During development the population runs locally against the deployed shard, with everything kept in a data directory `packages/ai/data/<shardId>/` (git-ignored):

| File | Holds |
| --- | --- |
| `population.json` | Shard id, target population and templates; `world/world.json` sets the mix. |
| `connection.json` | The shard's public TCP address (the Railway TCP proxy for a Railway shard). |
| `residents.sqlite`, `credentials/` | Residents, checkpoints, accounts, skill snapshots, dungeon runs. |
| `assets/` | Client map files: `map1LegacyMUL.uop`, `staidx1.mul`, `statics1.mul`, `tiledata.mul`, `Cliloc.enu`. |
| `experiments/<run>/` | One directory per measured run. |

1. Check the shard answers: `nc -z -w 8 <host> <port>` with the host and port from `connection.json`. A Railway proxy can accept connections while the server behind it is down, so the first log lines decide.
2. Back up the database: a run migrates and changes it.
3. Run the measured population (at most 300 residents and 3600 seconds per run):

```sh
OUT=packages/ai/data/<shardId>/experiments/<run>
mkdir -p "$OUT" && cp packages/ai/data/<shardId>/residents.sqlite "$OUT/residents-before.sqlite"
caffeinate -i bun run packages/ai/src/load-test.ts --data packages/ai/data/<shardId> --count 250 --seconds 3600 --output "$OUT" \
  > "$OUT/stdout.log" 2> "$OUT/residents.log"
```

`caffeinate -i` keeps a Mac awake for the run; a sleeping machine pauses every session and shows up as one huge stall in `lag-spikes.ndjson`. `residents.log` holds every resident's log lines (`[fighter:Name] phase: note`). The output directory receives `population.json`, `provenance.json` (source hashes), `assignments.json`, `before.json`/`after.json` (resident state), `lifecycle.ndjson`, `telemetry.ndjson`, `lag-spikes.ndjson`, `last-<id>.json` per session, `timing.json` and `result.json` (counts, lag, memory).

4. Afterwards the reports read the same database: `bun run packages/ai/src/index.ts dungeons|skills|decisions --config packages/ai/data/<shardId>/population.json`.

A server listening on local port 2593 may be another project; always use the address in `connection.json`.

## Population mix

`world/world.json` is the single world configuration: enabled facets and cities, each profession's archetype, behavior, share of the population, weighted homes and hunting grounds, and `population.max` (250), which caps any requested count. `applyWorld` (`world.ts`) turns it into templates and a fixed allocation. Population files can also list templates and counts directly ([templates](templates.md)).

## Life phases

Each resident moves between life phases (`life.ts`), configured under `lifecycle` in `world/world.json`:

| Phase | What happens |
| --- | --- |
| `work` | The resident's own loop: mining, hunting, fishing, taming, stealing... |
| `dungeon` | A dungeon run, alone or in a party, once the resident qualifies ([dungeons](dungeons.md)). |
| `errands` | The role's own town trip (a fighter sells, banks and restocks; a miner or lumberjack banks), otherwise a bank visit ("bank", "balance"). |
| `leisure` | Time at the home town's bank or an inn or tavern, shifting about now and then; conversation goes on as usual. |
| `visit` | Travel to another enabled town (nearer ones more likely), linger at its bank or an inn, come home. |
| `practice` | Supporting-skill training and rest. |

`mix` names the time split in `mixes`: `mostly-work`, `balanced` (the default: work 40, dungeon 15, errands 10, leisure 15, visit 10, practice 10) or `social`. A phase's chance is its share over its mean length from `minutes`, so time comes out at the shares. Temperament shades each resident: sociability raises leisure and visits, risk tolerance dungeons, and `restlessness` (0.7–1.3) shortens or stretches every phase. With a decision provider, Jev picks the next phase (`life-phase`) with the local pick as the baseline.

Phases change only at break points: a fighter leaving town for the hunt, a profession between turns, a miner after banking, a lumberjack back from town. At most `maxSwitchesPerMinute` (5) residents per 50 in the runtime change phase in any minute; the others carry on a minute longer, and one whose phase already finished (errands, a visit, a dungeon run) works that minute instead of repeating it. A phase the world prevents (no route, no banker) ends early and the resident does something else. The current phase is kept in the checkpoint (`life`).

### The skill curve

The time split leans with each resident's progress `p`, the mean of its primary skills over 100 (`skillCurve`): the lower the skills, the more time goes to work and practice, where skills rise; the higher, the more to leisure and visits, the long trips that are nearly absent early on. Work weighs `1 + 0.5(1 - p)`, practice `2 - p`, leisure `0.3 + 0.7p`, visits `p²`; errands and dungeons are untouched (dungeons wait for 80.0 anyway). On the balanced mix that is, as shares of time:

| Progress | Work | Practice | Leisure | Visits |
| --- | --- | --- | --- | --- |
| 20 | 53% | 17% | 6% | 0% |
| 50 | 49% | 15% | 10% | 2% |
| 80 | 44% | 12% | 13% | 6% |
| 100 | 40% | 10% | 15% | 10% |

Jev, when configured, sees the progress in its life-phase state.

### Chaos

Real players wander off their line, so residents do too, always with a purpose (`chaos.ts`, `wander.ts`). A resident's chaos is the population's (`ai.chaos` in the shard's `gemwright.json`, else `lifecycle.chaos` in `world/world.json`, 0.3 by default), varied 0.5-1.5x per character and scaled by skill progress (`0.4 + 0.6p`), so a resident still building its skills stays focused. With it:

- a walk over 60 tiles sometimes (half the chaos) goes by way of a real place near the line, a shop, bank or healer adding at most 40% (60 tiles) to the trip, where the resident looks around 3-10 seconds;
- every 32 steps (a quarter of the chaos) someone within four tiles gets a passing greeting and a short pause, once per person;
- in town, a planned visit or leisure sometimes (a third of the chaos) becomes another phase, and phase lengths swing by up to half the chaos either way.

Work loops never abandon their destination: a miner with a full pack still reaches the forge, by a detour at most. Sneaking thieves never wander.

## Spread

`spread.ts` keeps where each resident was last seen (reported on every phase change through `noticePeers`) so the population spreads out: no crowd on one screen, nobody alone across the map. A leisure spot is picked for company, not a crowd (best with about three residents within twelve tiles, less likely alone, falling away beyond eight); a town to visit is likelier the nearer it is and the fewer residents it has; a fighter moving on skips cemeteries with eight or more residents; a dungeon run weighs how many residents are already inside each dungeon of its pool. Like the allocator that gives residents their homes, this is the population's arrangement rather than one character's knowledge; up close residents judge by what they observe.

## Guards

Every resident session watches for criminals and murderers (`guards.ts`): inside a guarded town (the server's last word on it, "under the protection of the town guards", or near a bank before any), a grey or red player within twelve tiles makes the resident say "guards" (speech keyword 0x0007, `GuardedRegion.CallGuards`), at most once a minute per offender. Residents that are dead, grey or red never call; bolder residents (by risk tolerance) call more readily.

## Telling residents apart

Residents differ through their [temperament](templates.md#temperament), their own experience and decision history, and the ordinary world. Miners favour their own part of the district and avoid spots and forges someone else is working; fighters walk their own patrol direction, spread over cemeteries, and leave undead another player stands next to. Encounters with fellow residents are remembered, and residents talk ([conversation](conversation.md)).

## Performance

Short runs pass at 100, 150, 200 and 250 clients on ServUO: event-loop p95 5 ms and p99 10 ms, no reconnects or movement timeouts, worst mean movement acknowledgement 44 ms, peak memory under 750 MB. Long-running populations are not yet evaluated.

- **Pathfinding** runs in two workers with fixed typed-array workspaces, a bounded queue, cancellation and shared map buffers. Verified straight segments and public-map waypoint corridors (`path-corridors.ts`) split long routes into short local searches. Terrain caches are bounded at 32,768 cells per terrain; mining-site catalogs are shared.
- **Transport** uses Bun native sockets, reuses decompression storage and avoids copying packets. Handshakes are limited in concurrency and start rate (`connection-admission.ts`).
- **World state** indexes entities by parent, so pack scans and mount lookups never walk every entity.
- **Movement** pacing accounts for time already spent waiting for an acknowledgement. A movement timeout sends a client resync (0x22); ServUO re-sends the position, the step counts as refused and navigation tries another direction. Only an unanswered resync leads to a reconnect.
- **Stalls.** `stall-probe.ts` records main-thread time per entry point with every lag spike over 20 ms. Behavior loops always yield.

These patterns follow ServUO's own: `FastAStarAlgorithm` (reusable arrays, bounded local search), `PathFollower` (retained paths, repath delay), `MessagePump`/`NetState` (bounded slices, pooled buffers) and `BaseVendor` (eight-tile vendor range).

`load-test.ts` runs a measured population from `world.json` and records configuration, lifecycle events, telemetry and latency summaries for each run.
