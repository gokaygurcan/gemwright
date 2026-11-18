# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

[gemwright.org](https://gemwright.org) · [Documentation](https://gemwright.org/docs)

## Usage

Private package. Requires Bun 1.4.3 or newer. Run it from a shard folder the analyzer has pulled into:

```sh
bun packages/simulator/src/serve.ts --land .gemwright/pulls/<stamp>/land --port 4200
```

```text
  --land <directory>  A pull's land (default: newest .gemwright/pulls entry with one)
  --port <port>       Port to serve on (default: 4200)
```

The simulator rebuilds a resident as it stands at the end of its history and lets you live on as it:

- **What it is**: the mind's whole state (self, where, here, traits, things, beliefs, ventures…), every value editable.
- **What it asked while deciding**: every question planning put to the mind while weighing, with the answer it got. Pin any answer to change what the resident decides with.
- **What it could do**: every option it weighed, best first. Do one and decide what came of it (success, time taken, health, place, skill, any perceived events).
- **Judgements**: the AI's tuning values for this resident.

Every change is a step you can take back with Undo.

## License

MIT
