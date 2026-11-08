# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

[gemwright.org](https://gemwright.org) · [Documentation](https://gemwright.org/docs)

## The loop

```txt
perception → goal/planning → profession loops → action arbiter → network
```

## Usage

Requires Bun 1.4.3 or newer.

```sh
npm install @gemwright/ai
cd node_modules/@gemwright/ai
bun dist/index.js --help
```

```text
Gemwright AI runtime and headless player sessions

Run from the AI package directory after building:
  bun dist/index.js archetypes
  bun dist/index.js validate --config templates/population.example.json
  bun dist/index.js plan --config templates/population.example.json
  bun dist/index.js reconcile --config templates/population.example.json
  bun dist/index.js residents --config templates/population.example.json
  bun dist/index.js decisions --config <population.json>
  bun dist/index.js skills --config <population.json>
  bun dist/index.js dungeons --config <population.json>
  bun dist/index.js session --config <population.json> --connection <connection.json>
  bun dist/index.js population --config <population.json> --connection <connection.json> --assets <dir> --duration <s>

Options:
  --config <path>  Required, explicit population configuration
  --db <path>      Default: data/<shardId>/residents.sqlite (relative to this module)
  --help          Show this help

Session options:
  --connection <path>   Required endpoint/profile configuration
  --resident <id>       Default: first desired active resident
  --create-character   Explicitly allow local credentials and normal account/character creation
  --shard <path>       The shard's gemwright.json (expansion, account settings); ServUO only
  --speech claude      Replies in each resident's own voice (Claude Haiku 5.5; needs ANTHROPIC_API_KEY)
  --exercise           Walk, speak, open the backpack, and target with a miner's tool
  --reconnect          Disconnect and verify the same character can reconnect
  --reconnect-attempts  Recovery budget during observation, default 3, maximum 10
  --duration <seconds> Observe after entry/exercise, default 5, maximum 3600
  --decisions <path>    Optional Jev/local decision configuration (behavior sessions only)
  --fighter-assets <path> Run the Britain graveyard swordsman using public Trammel client assets
  --miner-assets <path> Run the Minoc miner behavior using public Trammel client assets

Population options (all desired-active residents in one process, one shard lease):
  --assets <path>       Public Trammel client assets; each template's activities pick miner or fighter
  --stagger <seconds>   Delay between resident logins, default 20
  --limit <count>       Run only the first N desired-active residents
  (also --connection, --create-character, --reconnect-attempts, --duration, --decisions)

reconcile persists desired residents; it does not create accounts or log anyone in.
residents displays local intentions, not actual online population.
decisions summarizes each resident's provider choices against the deterministic baseline.
dungeons summarizes recorded dungeon runs: solo runs, parties assembled or abandoned, and how they ended.
```

Resident service:

```sh
AI_DATA=/path/to/data UO_HOST=127.0.0.1 GEMWRIGHT_SHARD="$(cat /path/to/gemwright.json)" bun dist/serve.js
```

```text
AI_DATA           Persistent directory, including assets/ (default: /app/data)
UO_HOST           ServUO endpoint (required)
UO_PORT           Server port (default: 2593)
GEMWRIGHT_SHARD   Shard configuration JSON (required)
TYPESAFE_API_KEY  Required when ai.decisions is jev
CLOUDFLARE_ACCOUNT_ID Required for Clef inference
CLOUDFLARE_API_TOKEN  Workers AI token for Clef inference
ANTHROPIC_API_KEY Required when ai.speech is claude
```

Set `ai.decisions` to an ordered provider list:

```json
{
  "ai": {
    "decisions": [
      { "provider": "clef", "model": "clef-flash" },
      { "provider": "jev", "model": "jev-1.13.0" },
      { "provider": "local" }
    ]
  }
}
```

Providers run in order, falling back on exhaustion or failure. `clef` is shorthand for this list;
`local` and `jev` remain supported. Standalone `--decisions` files use `providers` for the same list.
Optional `credentialEnv` overrides the token variable. No Cloudflare Worker is needed.

Budgets cover the whole population, persist across restarts, and reset at midnight UTC.
Clef is capped at the free 10,000 neurons/day ($0.11); uncertain charges stay reserved.
Other applications on the same paid account can consume that allowance and cause overage.

## License

MIT
