# @gemwright/cli

## 0.11.0

### Minor Changes

- The CLI is now `gemwright init` and `gemwright shard <command>` (setup, deploy, start, stop, status, logs, pull, restore, update), each with its own flags and help. `--target local|railway|vps` replaces `--local`, and the last deployed target becomes the default. Old commands fail with the new one to use.

- Local and VPS deployments keep one game-file folder, mounted read-only into every service and synced by checksum, so only changed files are copied or sent.

- `gemwright shard status` shows each component as running, starting, stopped, failing or missing, on local, Railway and VPS deployments.

- VPS deployments run Docker only: `gemwright shard setup` prepares a server over SSH, including swap on small servers; deploys check the server first, build images on the deploying machine, restart only the named components, run AI residents, serve the browser client over HTTPS on a configurable domain, and finish only when players can connect. Native VPS mode is removed.

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn where vendors stand and creatures spawn, in towns, on Haven Island and overland, from the shard's own world files (Spawns/*.xml and Regions.xml), which `gemwright deploy --ai` keeps on the AI volume and replaces only when they change; `--world <path>` and `--world-pull` teach them from a world save instead, with whatever was placed or changed in game; a fighter skips any ground with a creature that attacks on sight it is not ready for.

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - @gemwright/common holds the shard's structured facts in one place: every ServUO creature's stats, aggression, AI and taming (`game/creatures.json`, from the scripts, including what a creature inherits from its base), every facet's regions (`game/regions`), what each land tile is (`game/land`: water, grass, sand, rock, cave, road and the rest, from tiledata and the ServUO rules) and the world save reader (`saves`, RunUO and ServUO binary saves; Sphere saves are recognised but not read yet). AI residents share these instead of separate catalogues and per-resident guesses, and `gemwright deploy --ai --world <path>` also takes the forges, ankhs, spinning wheels and looms really standing in the world from the save.

### Patch Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents find Haven Island, spinning wheels, looms and sheep pastures in the shard's world files, and each town's mines and woods on the map; the public roads they follow on long walks are walked once at start and kept on the data volume until the towns or the map change. The AI image no longer carries hand-made location files.

## 0.9.0

### Minor Changes

- Run the server, web client and AI residents on this machine with Docker Compose: `deploy`, `logs`, `pull` and `restore` accept `--local`, `stop --local` and `start --local` pause and resume parts, and `--server-port`/`--client-port` choose the local ports.

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Split the Node-compatible CLI from the gemwright wrapper and deliver contained Bun AI/client runtimes. Add explicit schema-version compatibility, exact service package selection and independent Railway service updates with persistent resource preservation. Align private workspace versions through the shared Changesets group and make partial publication and release-metadata retries resumable.
