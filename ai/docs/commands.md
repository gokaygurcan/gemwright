# Commands

[Documentation index](README.md)

Commands run from the repository root with Bun and the root development dependencies installed. Configuration paths resolve from the working directory; the database defaults to `ai/data/<shardId>/residents.sqlite` (override with `--db`).

```sh
# Configuration only: no database, no network.
bun run ai/src/index.ts archetypes
bun run ai/src/index.ts validate --config <population.json>
bun run ai/src/index.ts plan --config <population.json>

# Roster: create or reconcile residents (no logins), then inspect them.
bun run ai/src/index.ts reconcile --config <population.json>
bun run ai/src/index.ts residents --config <population.json>

# Reports.
bun run ai/src/index.ts decisions --config <population.json>   # Jev against the baseline
bun run ai/src/index.ts skills --config <population.json>      # hourly skill snapshots
bun run ai/src/index.ts dungeons --config <population.json>    # dungeon runs and parties

# Play: one resident, or the whole population in one process.
bun run ai/src/index.ts session --config <population.json> --connection <connection.json> [--shard <gemwright.json>] ...
bun run ai/src/index.ts population --config <population.json> --connection <connection.json> \
  --assets <dir> --duration <seconds> [--shard <gemwright.json>] [--decisions <decisions.json>]

# Checks.
bun test ai/tests
bun run --cwd ai typecheck
bunx --no-install biome check ai
```

`bun run ai/src/index.ts --help` lists every option. `validate` and `plan` are pure; `reconcile` never creates accounts or logs in; `residents`, `decisions`, `skills` and `dungeons` need an existing database and never modify it. See [sessions](sessions.md) and [population](population.md) for the play commands.

## Source layout

```text
ai/
  catalogs/        spells and tamable creatures
  connections/     connection file example
  decisions/       decision provider configurations
  docs/            this documentation
  locations/       place catalog, services, route corridors
  templates/       archetypes and the population example
  world/           world.json: facets, cities, professions, population cap
  tests/           focused checks
  data/            local state, never committed
  src/
    index.ts                      CLI
    config.ts, archetypes.ts, world.ts, temperament.ts, names.ts   templates and population
    store.ts, checkpoint-migrations.ts, credentials.ts, skill-snapshots.ts, ownership.ts   persistence
    connection.ts, shard-profile.ts, connection-admission.ts      connecting to ServUO
    protocol/                     packets, framing, transport, world view, session
    run-session.ts, run-population.ts, behavior-supervisor.ts, setback.ts   running residents
    terrain.ts, navigation.ts, path-*.ts, route-waypoints.ts, direct-route.ts, moongate.ts, work-areas.ts   movement
    locations.ts, mobile-approach.ts, vendor-trade.ts, bank-gold.ts, service-experience.ts   town
    miner*.ts, mining-catalog.ts  mining
    lumberjack.ts, lumber-trees.ts
    fighter*.ts, combat-risk.ts, cemeteries.ts, mage-combat.ts, hunting-party.ts, party-talk.ts   combat
    resurrection.ts               death
    profession*.ts, fisher.ts, tailor.ts, crafter.ts, bard.ts, tamer*.ts, thief*.ts   professions
    mounts.ts, mount-*.ts
    skills.ts, skill-training.ts, craft-training.ts, magery.ts, training.ts, stat-locks.ts, progression.ts   skills
    decisions.ts, decision-provider.ts, experience.ts   decisions and memory
    dialogue.ts, conversation.ts, relationships.ts      speech
    dungeon*.ts                   dungeons
    load-test.ts, stall-probe.ts, build-routes.ts, build-dungeons.ts, build-monsters.ts, build-crafts.ts, build-aggression.ts, report.ts   measurement, routes and catalogs
```

Related: [sessions](sessions.md) · [templates](templates.md).
