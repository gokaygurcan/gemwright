# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Usage

Private package. Build from the repository root with `bun run build`; run with Node.js 24 or newer.

```sh
node packages/server/dist/staging.js /path/to/shard [--ai]
```

```text
Usage: node dist/staging.js <shard-directory> [--ai]

Arguments:
  <shard-directory>  Prepared shard containing gemwright.json

Options:
  --ai              Include the ServUO AI patch

Stages the emulator build context under the shard's .gemwright/deploy directory.
Supported emulators: servuo, sphere, sphere-x, runuo, modernuo.
```

## License

MIT
