# Running a population

[Documentation index](README.md)

```sh
bun run packages/ai/src/index.ts population --config <population.json> --connection <connection.json> \
  --assets <dir> --duration <seconds> [--shard <gemwright.json>] [--decisions <decisions.json>]
```

`run-population.ts` holds one shard lease for the population. Residents have independent sessions, reconnect budgets and supervision. Logins are staggered (`--stagger`, default 20 seconds); `--limit` restricts the run. One resident's failure does not stop the others. Continuous mode does not schedule offline breaks. `proofs/population-latest.json` records outcomes and runtime lag.

## Data directory

Local state is `packages/ai/data/<shardId>/` (git-ignored); the deployed AI uses `/app/data`.

| File | Purpose |
| --- | --- |
| `population.json` | Shard ID, templates and target population. |
| `connection.json` | Public shard address. |
| `residents.sqlite` | Identities, credentials, checkpoints and history. |
| `life-events/` | Compressed daily action and outcome history, separate from checkpoints. |
| `retired.json` | UUIDs excluded from startup reconciliation without replacement. |
| `assets/` | `map1LegacyMUL.uop`, `staidx1.mul`, `statics1.mul`, `tiledata.mul`, `Cliloc.enu`. |

`world/world.json` defines profession shares, homes, hunting grounds and the population cap. Shard-specific cohorts live in `ai.cohorts` in `gemwright.json` and count within `ai.population`. Direct template counts are also supported ([templates](templates.md)).

Retirements append to the existing `retired.json`: `{ "residents": [{ "id": "<UUID>" }] }`. Restart the AI to reconcile. Preserve earlier entries. Retirement retains history and does not delete the character.

## How residents decide

`LIFE_GOAL` is **grow stronger and richer through your trade, without dying**. `resident-goal.ts` selects one objective; `goal-turn.ts` dispatches it across all runners: recover, obtain a work tool, fulfill an accepted order/commitment, earn, or train within a budget.

Production is intermediate: goods must reach sale/turn-in and the outcome must be observed. Learning requires relevant skill growth within budget; earning requires net funds growth. Movement, purchases, damage/healing and inventory churn do not count as gains. Safety interrupts work; blocked steps record a reason and yield to another plan. Objectives and steps have deadlines. Optional activities follow verified progress.

`loop-watch.ts` detects repeated steps and five minutes without verified gains, allowing bounded objective travel and urgent survival actions to finish. [Journeys](locations.md) handle disconnected land and dungeon links. [Persistence](persistence.md) describes restart reconciliation.

## Measuring progress

Back up the database before a load run; the run changes it.

```sh
bun run packages/ai/src/load-test.ts --data packages/ai/data/<shardId> --count 100 --seconds 1800 --output <run-dir>
```

Runs allow at most 300 residents and 3,600 seconds. Output includes source hashes, before/after state, lifecycle events, telemetry and `result.json`. `index.ts dungeons|skills|decisions --config <population.json>` reads stored reports.

`progress-report.ts --db <residents.sqlite> --before <older-copy>` compares skills, funds, deaths and activity. Compare the same UUIDs over the interval and report retirements separately; changing membership is not evidence of better behavior.
