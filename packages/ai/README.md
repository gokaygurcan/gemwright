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

## V2 behavioral audit

V2 appends perceptions, predictions, outcomes and decisions to `AI_DATA/history.sqlite`.
`life-started` records the resident ID, trade and life goal; `life-ended` records termination
or failure. Every `considered` event includes the selected plan, traits and five leading
alternatives with scores, durations and loop blocking. Guard protection follows the place
(`place` events) and the server's entry/exit messages, the server winning; funding details explain
the value of earning money for a missing tool. A plan leading to another island or dungeon level
records `bound` with its destination and the teleporters and moongates on the way. `missing`
records a thing of its own it reached for and did not find, and `listed` an opened container's
contents; both correct what it believes it has. `plan-ended` records completed steps,
useful progress and any recorded interruption or client refusal. Predictions and outcomes
provide the expected gains, actual gains and prediction errors behind those decisions.

After deployment approval, observe Finn and Rowan concurrently for at least 60 minutes each
in the populated shard, with both resident entries set to `mind: "v2"` in the online roster
and no scripted objectives, staff commands or interventions.
Record the UTC start and end timestamps and map their names to the full resident IDs from
`residents`. Check session boundaries and recovery logs: disconnected time is not observation
time. Extend the observation if either resident has gaps. Preserve existing memory and data.

Export the complete window for each resident (JSON lines, without the normal 100-event limit):

```sh
bun dist/v2/history-cli.js --db /app/data/history.sqlite --resident <id> --since <ISO-start> --until <ISO-end> --json > resident-history.jsonl
```

Run this inside the AI container, redirecting output to the observing machine when using
`docker exec`. The reader is read-only and can run while residents continue living.
Include the preceding `born`, `trade` and latest `life-started` records when interpreting an
already-running session. Use `--counts` and `--attempts` for summaries; keep the raw export.

Reconstruct each resident's goals, choices, progress and adaptations from the ordered history.
Compare alternatives and interruption reasons; look for repeated unproductive plans, frequent
switches, stagnation and contradictory choices. A completed plan alone does not establish
useful progress. The audit succeeds when the history explains activities and motivations;
mechanics tests alone do not establish long-term coherence or convincing behavior.

## Perception

There are three main components that are non-negotiable, and known by the resident/bot at all times instantly:

1. Where it is (`mind.here`): its regions innermost first, town, dungeon, guarded or wild, the
   island or dungeon level it stands on, landmarks in sight, how its land is left (teleporters and
   moongates, and where each leads) and what its region offers (vendors, bankers, healers, ankhs,
   spawns). Built once at start from the shard's Regions.xml, spawns, decoration, teleporters and
   walk graph (`src/v2/atlas.ts`); every step is a lookup, recorded as `place` when it changes. It
   also knows which part of its region it is in (north-west Minoc), the public road it is on, where
   that road leads and which end it faces (`src/v2/roads.ts`), whether it went up or down a dungeon
   level, and what spawns on the level it is on. Named moongates, shrines and town mines are
   landmarks. Where the server's guard message contradicts the map, `place-disagreed` records it and
   the server is believed. After a refused step, a teleporter, a moongate or a map change it asks the
   server where it stands (0x22).
2. What it is (`mind.self`): every skill with value, base, cap and lock; stats, stat locks and cap;
   health, mana, stamina, weight, followers, resistances, luck and weapon damage. `abilities()`
   derives from ServUO's rules its weapon and craft skills, parry chances with a shield and with
   one- or two-handed weapons, the creatures it can tame and the odds, and what it can still carry
   (`src/v2/self.ts`). Its growth reads its skills' base against the shard's total cap
   (`Config/PlayerCaps.cfg`, shipped with the world files), what rose in the last hour and how each
   skill is locked; its stat locks are set toward the stats its trade trains (ServUO SkillInfo,
   `src/v2/growth.ts`).
3. What it has (`mind.has()`): worn by layer, its pack and every bag in it, its bank as last seen,
   movable things on the ground in sight and the contents of corpses about it, each with kind, worth
   and weight (`src/v2/things.ts`). Every new thing of its own is looked at closely (its hover)
   between the steps of its plans (`src/v2/hover.ts`); things on the ground and corpses out of sight stay believed
   for as long as their kind is seen to stay (`src/v2/places.ts`); any corpse seen counts.

Each is written down when it changes (`place`, `abilities`, `holding`) and analyze's Minds page shows
the latest of each; with `ai.debug` on, a resident says over its head where it has come to, what it
can newly tame and a find it values.

Choosing reads only the mind: no planning code reads the world directly. The hands and other doers
that act on the world read the live screen through one read-only view (`screenOf` in
`src/v2/perceive.ts`); `perceive.ts` is the only reader of the session's world.

A death robe's only place is the floor: every one a resident wears, carries or sees in its open bank
box is put down where it stands, at the pace ServUO allows and retried on the same tile until it
lies there, before it takes any other action or step. A ghost goes straight to the nearest healer
or ankh by the way there and steps into its reach to be offered resurrection (a healer offers to a
ghost entering two tiles of it; an ankh when used from within two).

`ai.cities` in `gemwright.json` keeps residents to those cities and the region each lies in (New
Haven: Haven Island): bankers, vendors, healers, ankhs, forges, hunting grounds, harvest tiles and
changes of course outside it are never chosen, and a resident found outside walks back first.

Planning reads them: bankers, healers and ankhs are chosen by the way there; a plan runs as long as
it is expected to take; weapon and shield follow its parry chances; a mount it can tame is tamed
rather than gone without; craft tools are used only in crafts it has skill in.

## License

MIT
