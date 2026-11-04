# @gemwright/deployment

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn where vendors stand and creatures spawn, in towns, on Haven Island and overland, from the shard's own world files (Spawns/*.xml and Regions.xml), which `gemwright deploy --ai` keeps on the AI volume and replaces only when they change; `--world <path>` and `--world-pull` teach them from a world save instead, with whatever was placed or changed in game; a fighter skips any ground with a creature that attacks on sight it is not ready for.

### Patch Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents no longer stand still for good when securing their goods cannot lower a small risk: once recovery has been tried in the same situation, a healthy, unthreatened resident goes back to work, and recovery away from home walks back to its town's bank first. Ghosts look for healers only where a spawner keeps one, not at wildlife spawners a wandering healer roams from, and the AI world files no longer need a town guide.
- Updated dependencies [[`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf), [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf), [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf), [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf), [`8872cc9`](https://github.com/gokaygurcan/gemwright/commit/8872cc9c1d5ab0109f47aac7e35376a299f28682), [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf)]:
  - @gemwright/common@0.10.0
  - @gemwright/client@0.10.0

## 0.9.0

### Minor Changes

- Run the server, web client and AI residents on this machine with Docker Compose: `deploy`, `logs`, `pull` and `restore` accept `--local`, `stop --local` and `start --local` pause and resume parts, and `--server-port`/`--client-port` choose the local ports.

### Patch Changes

- Updated dependencies [`eb038f3`, `fce8494`]:
  - @gemwright/common@0.9.0
  - @gemwright/client@0.9.0

## 0.8.3

### Patch Changes

- Updated dependencies []:
  - @gemwright/client@0.8.3
  - @gemwright/common@0.8.3

## 0.8.2

### Patch Changes

- Updated dependencies []:
  - @gemwright/client@0.8.2
  - @gemwright/common@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies []:
  - @gemwright/client@0.8.1
  - @gemwright/common@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [[`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168)]:
  - @gemwright/client@0.8.0
  - @gemwright/common@0.8.0
