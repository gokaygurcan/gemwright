# gemwright

## 0.5.0

### Minor Changes

- The repository is now a Bun workspace. The CLI ships the AI residents, the web client and their shared code inside its package (`workspace/`), and every deployed image installs from the same frozen lockfile.
- AI residents gained houses, guilds and Chaos and Order wars, gather until their packs are full, stop practising capped skills, hunt across Trammel's spawns and keep their bank boxes from filling up.
- `gemwright pull` downloads a shard's saves, logs and AI resident database for offline analysis.

### Patch Changes

- Missing deployment state (a Railway project, service or volume, an emulator source or an upstream config file) now fails with a message naming what is missing.
