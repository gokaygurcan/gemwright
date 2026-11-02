# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Usage

Private package. Requires Bun 1.4.3 or newer. Build from the repository root with `bun run build`.

```sh
bun packages/analyze/dist/src/index.js --saves /path/to/Saves
bun packages/analyze/dist/src/serve.js --local /path/to/Saves --port 4100
```

```text
Report: bun dist/src/index.js [options]
  --saves <directory>  Saves folder (default: newest .gemwright/pulls entry)
  --output <file>      Write the report instead of printing it
  --character <name>   Show one character by name or serial
  --json <file>        Export characters and items as JSON

Browser: bun dist/src/serve.js [options]
  --shard <directory>  Shard folder whose pulls to browse (default: current directory)
  --local <directory>  Inspect a local Saves folder
  --files <directory>  Game files for rendering character art
  --port <number>      HTTP port (default: 4100)

Without --local, the browser uses .gemwright/pulls in the shard folder.
```

## License

MIT
