# Commands

[Documentation index](README.md)

Commands run from the repository root with Bun and the root development dependencies installed. Configuration paths resolve from the working directory; the database defaults to `packages/ai/data/<shardId>/residents.sqlite` (override with `--db`).

```sh
# Configuration only: no database, no network.
bun run packages/ai/src/index.ts archetypes
bun run packages/ai/src/index.ts validate --config <population.json>
bun run packages/ai/src/index.ts plan --config <population.json>

# Roster: create or reconcile residents (no logins), then inspect them.
bun run packages/ai/src/index.ts reconcile --config <population.json>
bun run packages/ai/src/index.ts residents --config <population.json>

# Reports.
bun run packages/ai/src/index.ts decisions --config <population.json>   # Jev against the baseline
bun run packages/ai/src/index.ts skills --config <population.json>      # hourly skill snapshots
bun run packages/ai/src/index.ts dungeons --config <population.json>    # dungeon runs and parties

# Play: one resident, or the whole population in one process.
bun run packages/ai/src/index.ts session --config <population.json> --connection <connection.json> [--shard <gemwright.json>] ...
bun run packages/ai/src/index.ts population --config <population.json> --connection <connection.json> \
  --assets <dir> --duration <seconds> [--shard <gemwright.json>] [--decisions <decisions.json>]

# Checks (from the repository root).
bun run lint && bun run typecheck && bun run test
```

`bun run packages/ai/src/index.ts --help` lists every option. `validate` and `plan` are pure; `reconcile` never creates accounts or logs in; `residents`, `decisions`, `skills` and `dungeons` need an existing database and never modify it. See [sessions](sessions.md) and [population](population.md) for the play commands.

## Source layout

```text
packages/ai/
  catalogs/      spells, monsters, tamables, hunting and taming grounds, crafts, house lots
  connections/   connection file example
  decisions/     decision provider configurations
  docs/          this documentation
  locations/     places, services, route corridors, teleporters, New Haven
  templates/     archetypes and the population example
  world/         world.json (facets, cities, professions, population cap) and names
  tests/         focused checks
  data/          local state per shard, never committed
  src/           the runtime: CLI (index.ts), protocol/, one module per trade or activity,
                 and offline catalog builders (build-*.ts), which read the ServUO source
```

Related: [sessions](sessions.md) · [templates](templates.md).
