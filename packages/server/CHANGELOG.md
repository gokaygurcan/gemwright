# @gemwright/server

## 0.11.0

### Minor Changes

- ServUO loads the scripts its image build compiled instead of compiling them again at every start, and server images accept a mounted game-file folder.

### Patch Changes

- Staging leaves macOS Finder and AppleDouble files out of shard folders, and the ServUO build keeps no compiler server running.

## 0.10.0

### Minor Changes

- [`62939d6`](https://github.com/gokaygurcan/gemwright/commit/62939d673e81b508498a02bb397662ce35691abf) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - AI residents learn where vendors stand and creatures spawn, in towns, on Haven Island and overland, from the shard's own world files (Spawns/*.xml and Regions.xml), which `gemwright deploy --ai` keeps on the AI volume and replaces only when they change; `--world <path>` and `--world-pull` teach them from a world save instead, with whatever was placed or changed in game; a fighter skips any ground with a creature that attacks on sight it is not ready for.

## 0.9.0

### Patch Changes

- Server images advertise `GEMWRIGHT_PUBLIC_PORT` (default 2593) to native clients outside Railway.

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

No changes in this release.
