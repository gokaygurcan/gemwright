# gemwright

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
