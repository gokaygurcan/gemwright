# Decisions

[Documentation index](README.md)

A provider chooses among legal candidates built by code. Local rules remain the baseline and fallback; the model cannot invent commands, serials or actions. Current model pins and accounting rates live in `decision-provider.ts` and the decision configuration files.

## Configuration

Pass `--decisions <file>` to `session` or `population`:

| Example | Use |
| --- | --- |
| `decisions/local.example.json` | Local rules without provider requests |
| `decisions/jev.example.json` | Jev with normal limits |
| `decisions/jev-compare.example.json` | Higher consultation frequency for comparison |

The configured environment variable supplies the API key; the endpoint is fixed in code. Requests have timeouts, size limits, spacing, per-run/day limits and resident/population spending caps. `share` selects a stable fraction of resident UUIDs for provider use.

Budget is reserved durably before transport. Valid responses settle actual usage; ambiguous requests retain their reservation. Population spend survives restarts. The coordinator owns cancellation and retries; authentication failures disable the provider for the run. Keys and error bodies are excluded from logs.

## Guards and evidence

The coordinator checks candidate IDs, probabilities, confidence, model identity and usage. Changed observations cancel pending requests; preconditions are checked again before execution. Safety does not wait for the model.

Checkpoint decision history is bounded. Journal events retain decision identity, observed state, candidates, baseline, source, reason and execution outcome. Recorded failure or interruption is not a completed intention.

## Comparing outcomes

```sh
bun run packages/ai/src/index.ts decisions --config <population.json>
```

Per-kind tallies compare choices agreeing with and differing from the baseline. After at least twenty divergent choices, a success rate more than ten percentage points below the baseline suppresses provider use for that kind. These associations are evidence for comparison, not proof of causation.

See [persistence](persistence.md) for storage and journal replay.
