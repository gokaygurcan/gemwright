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

## Data directory

Each shard's state lives in one data directory, `packages/ai/data/<shardId>/` locally (git-ignored) or `/app/data` on a deployed AI service:

| File | Holds |
| --- | --- |
| `population.json` | Shard id, target population and templates, generated from `world/world.json`. |
| `connection.json` | The shard's public address. |
| `residents.sqlite` | Residents, checkpoints, accounts, skill snapshots, dungeon runs ([persistence](persistence.md)). |
| `retired.json` | Optional: residents this shard no longer plays (see below). |
| `assets/` | Client map files: `map1LegacyMUL.uop`, `staidx1.mul`, `statics1.mul`, `tiledata.mul`, `Cliloc.enu`. |

To measure a population against a running shard (at most 300 residents and 3,600 seconds per run), back up `residents.sqlite` first, since a run changes it, then:

```sh
bun run packages/ai/src/load-test.ts --data packages/ai/data/<shardId> --count 100 --seconds 1800 --output <run dir>
```

The run directory receives the configuration, source hashes, resident state before and after, lifecycle events, telemetry, lag spikes and a `result.json` summary. The reports read the same database: `bun run packages/ai/src/index.ts dungeons|skills|decisions --config packages/ai/data/<shardId>/population.json`.

## Population mix

`world/world.json` is the single world configuration: enabled facets and cities, each profession's archetype, behavior, share of the population, weighted homes and hunting grounds, and `population.max` (300), which caps any requested count. `applyWorld` (`world.ts`) turns it into templates and a fixed allocation. Population files can also list templates and counts directly ([templates](templates.md)).

Settings that belong to one shard stay with that shard. Cohorts (residents of a fixed size started in one city, such as New Haven) are `ai.cohorts` in the shard's `gemwright.json`, `{ "New Haven": { "count": 50, "professions": { "miner": 6 } } }`, counted within `ai.population`. Residents retired by hand are listed in `retired.json` in the data directory, `{ "residents": [{ "id": "<resident UUID>" }] }`: they never log in again and are not replaced.

## How residents decide

Every resident lives by one goal: **grow stronger and richer through your trade, without dying** (better skills, more gold, fewer deaths; `LIFE_GOAL` in `self.ts`). The rules that follow from it:

- **Job first.** A resident that can do its trade does it. Supplies, bank trips, shopping and mounts happen only when they help the job and are affordable and reachable. Leisure and visits come only after it grew richer or more skilled since its last break, and last at most ten minutes (`life.ts`).
- **Survival limits risk, never stops action.** A fighter with any melee weapon fights; bandages and potions only shorten recovery. Fight confidence weighs the weapon actually held (fists without one), armour, health and what a death would cost (`fight-confidence.ts`, `fighter-prey.ts`).
- **It knows itself.** What it wears and carries, its gold, health and skills are read from its client every tick, and whether its trade can work now (`self.ts`: `selfNow`, `jobReady`). A trade without its tool and no money for one earns bare-handed first (`earn-bare-handed.ts`).
- **It remembers what came to nothing.** An errand that changed nothing it owns is not tried again for two hours, kept across restarts (`objective-memory.ts`: `errand`).
- **It knows where it can walk.** `locations/areas.json` (`build-areas.ts`) groups known places into areas joined by walks and teleporters; residents pick places in their own area or through a moongate, and a resident in an area with no moongate uses Recall or the stuck menu, hunting where it stands meanwhile (`areas.ts`).
- **It does not go in circles.** The same steps three times, or five minutes with nothing gained and no step of its job, send it back to its job for twenty minutes, logged as `[loop]` and shown on the analyzer's Loops page (`loop-watch.ts`).

`bun run packages/ai/src/progress-report.ts --db <residents.sqlite> --before <older copy>` measures the goal over a stretch of time: skills, gold and deaths for the population, and each resident as productive, looping, idle, wandering, stranded or died.
