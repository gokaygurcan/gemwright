# gemwright

## 0.9.0

### Patch Changes

- Updated dependencies [`0e8461f`]:
  - @gemwright/cli@0.9.0

## 0.8.3

### Patch Changes

- [`3244394`](https://github.com/gokaygurcan/gemwright/commit/324439482c15b07dfd9e718fa8155e86f9e5a11f) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Export AI and web client logs over OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, with player session and shard reachability events from the web client. Residents sell unfit gear to the shops seen paying for it. Release announcements wait long enough for npm to show new versions.
- Updated dependencies []:
  - @gemwright/cli@0.8.3

## 0.8.2

### Patch Changes

- [`ba62118`](https://github.com/gokaygurcan/gemwright/commit/ba6211860a29c3392b51807beaf467204ce6051d) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Add `gemwright logs` with `--server`, `--client`, `--ai` and `--watch`. Hide the system cursor over the web client's game canvas. Residents judge cemeteries by what spawns there, bank unsold wood on mining trips, heal themselves before resting, and no longer bounce between paired teleporters.
- Updated dependencies []:
  - @gemwright/cli@0.8.2

## 0.8.1

### Patch Changes

- [`c8c3d71`](https://github.com/gokaygurcan/gemwright/commit/c8c3d71ef607900bb3cfff332e9ca68840fb9c87) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Wait for npm to show newly published versions before announcing a release, and give the packed AI check the client version it requires.
- Updated dependencies []:
  - @gemwright/cli@0.8.1

## 0.8.0

### Minor Changes

- [`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Split the Node-compatible CLI from the gemwright wrapper and deliver contained Bun AI/client runtimes. Add explicit schema-version compatibility, exact service package selection and independent Railway service updates with persistent resource preservation. Align private workspace versions through the shared Changesets group and make partial publication and release-metadata retries resumable.

### Patch Changes

- Updated dependencies [[`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168)]:
  - @gemwright/cli@0.8.0

## 0.7.0

### Minor Changes

- AI residents live by one goal: grow stronger and richer through their trade, without dying. They know what they wear, carry and own at every moment, do their job first (a fighter with any weapon fights; bandages only shorten recovery), remember errands that gained nothing and leave them for two hours, choose only places they can actually walk to (a new map of walkable areas built from the client files), and a loop guard sends any resident that repeats itself or stands still for five minutes back to its job. Trades without their tool and money for one earn bare-handed instead of begging.
  
  The save analyzer opens on the list of pulls, with buttons to fetch a new pull, analyze or delete one, and is now a Preact app with sortable tables and a Loops page. `gemwright pull` no longer leaves database copies on the AI volume. Shard-specific settings (cohorts, retired residents) stay with the shard instead of the package, and the shipped catalogues are rebuilt from the ServUO source.

## 0.6.0

### Minor Changes

- AI residents always answer a player who speaks to them. With `"speech": "claude"`, Claude Haiku reads what a player says and answers from the resident's real situation: where it is going, what it is doing, and what it needs (a missing tool, bandages, potions, arrows, reagents or coins), so a player can bring it. Residents accept gifts in the trade window and thank the giver, go back to their corpses after a resurrection for their belongings, leaving the death robe behind, and buy a robe when their corpse is lost.

- `gemwright restore` puts a pull back on a Railway deployment: the world saves (ServUO) and the AI residents database. It uploads first, then restarts each service, which swaps the files in on boot and keeps the replaced ones. It always asks before changing the live shard (`--yes` to skip). `gemwright pull --cleanup` keeps only the newest pull once a pull is complete.

### Patch Changes

- Add observed party healing, bounded shared hunt-and-town plans, familiar companion invitations, and guild smith repair contracts. Prioritize valuable loot, confirm income from actual transfers, and retain a working purse and unpaid companion shares for player trades.

- AI residents prioritize safety and real supply needs, remember blocked objectives, and use alternative shops and income activities. Ranged combat covers bows, composite bows and all three crossbow families with their own ammunition and ranges. Encounters react to observed additional attackers, while spells and pet care require observed outcomes and retain uncertainty when confirmation is missing.

- Residents recognize nearby help, accept useful gifts and use compatible equipment upgrades. Add short cooperative outings, persistent goals and shared memories, supply orders alongside the existing market, individual session habits, and work-area learning from observed outcomes.

- AI residents grow and earn again: fighters hunt where a fight costs at most half their health and still teaches them, island fighters and Yew lumberjacks reach a blacksmith, bards and fishers keep a spare instrument or pole, and broke bards beg townsfolk. The first housing district is the Minoc mines.

## 0.5.0

### Minor Changes

- The repository is now a Bun workspace. The CLI ships the AI residents, the web client and their shared code inside its package (`workspace/`), and every deployed image installs from the same frozen lockfile.
- AI residents gained houses, guilds and Chaos and Order wars, gather until their packs are full, stop practising capped skills, hunt across Trammel's spawns and keep their bank boxes from filling up.
- `gemwright pull` downloads a shard's saves, logs and AI resident database for offline analysis.

### Patch Changes

- Missing deployment state (a Railway project, service or volume, an emulator source or an upstream config file) now fails with a message naming what is missing.
