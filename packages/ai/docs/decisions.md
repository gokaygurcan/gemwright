# Decisions

[Documentation index](README.md)

Residents act on local rules. Where a choice is a real trade-off, a decision provider picks among legal candidates the code builds: TypeSafe's Jev, or the local rule (the deterministic baseline). Code executes the choice; the model never invents serials, commands or actions.

## Provider

`decision-provider.ts` calls Jev through TypeSafe's official SDK ([`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript), pinned to 0.7.0, with a buffered `fetch` that works around its "Body already used" failure under Bun): `client.systemOne()` with one `choice()` question mapping candidate IDs to descriptions, a bounded `state` object and a pinned model. The key comes from the environment variable named in the config (`TYPESAFE_API_KEY`). The API root is set in code, so `TYPESAFE_BASE_URL` cannot redirect the key, and the SDK makes a single attempt: the coordinator owns timeouts, cancellation and budgets. The SDK's typed errors map to fallback reasons (`cancelled`, `timeout`, `http-429` with its retry-after, `http-<status>`, `network-error`); 401 and 403 disable the provider for the run. The typed answer is still checked against the candidate IDs, a complete probability map, the confidence range, token usage and the requested model; anything else becomes a fallback, never an action. SDK logging is off, so error bodies and keys are never logged.

Models are pinned (`jev-1.13.0` or `jev-1.14.0`), so an alias change never alters behavior. Both cost $0.042 per million input tokens, output free ([models](https://docs.typesafe.ai/models)).

## Configuration

| File | Use |
| --- | --- |
| `decisions/local.example.json` | Local rule only; no API requests. |
| `decisions/jev.example.json` | Jev with everyday limits. |
| `decisions/jev-compare.example.json` | Jev as often as limits allow, for comparing against the baseline. |

Limits: request timeout (100–5,000 ms), interval between requests (0–600,000 ms), requests per run (up to 10,000) and per UTC day (up to 50,000) per resident, a daily cost cap per resident (up to $5), a daily cost cap shared by the whole population (`maxPopulationDailyCostUsd`, default $0.16, which keeps a population under $5 a month; `spend-ledger.ts` records the day's spend in the residents database, so restarts do not reset it), and a request size cap (16,000 bytes). One request per resident is in flight at a time. Before sending, the runtime reserves the full 65,536-token context against the daily budget; a valid response settles it to actual usage, and a lost one keeps the reservation. There are no automatic retries; a 401 or 403 disables the provider for the run.

Pass a file with `--decisions` on `session` or `population`.

## State and guards

`decisions.ts` builds state from ordinary observations only: template and archetype, temperament, training goals, position, status, up to 24 backpack item totals, recent activities, recent decisions with their outcomes, and experience summaries. While a request is pending, the coordinator checks every 25 ms that identity, map, position, health, combatant, cursor and connection are unchanged; a change cancels the request (`observations-changed`). The chosen candidate's preconditions are checked again before it runs.

Every decision is a trace in the checkpoint (the last 24): kind, candidates, baseline, the model's choice and probabilities, latency, tokens, who decided (`model`, `local`, `fallback`, `stale`) and why, and the execution outcome reported afterwards. Decision memory has its own schema version.

## Decision kinds

| Kind | Chooses |
| --- | --- |
| `mining-activity` | Keep mining, smelt early, or bank early (mandatory weight, tool and safety rules run first). |
| `hunting-opponent` | Which verified undead to fight, patrol on, or head to town; asked only when there is a real trade-off. |
| `combat-tactics` | Press the attack, take a short bandaging break, or flee to town. |
| `town-trip`, `corpse-recovery` | Whether to go to town early; whether to try recovering the corpse (hard limits stay local). |
| `party-plan`, `party-invite`, `party-answer` | A leader's target; join or decline a party; join now, recover first, or sit a fight out. |
| `life-phase` | The next life phase at a break point: work, dungeon, errands, leisure, visit or practice ([population](population.md#life-phases)). |
| `help-request` | Offer advice or decline. |
| `speech-addressee`, `speech-intent`, `speech-reply` | Whether a line is meant for this resident, what it means, and which truthful reply to give. |

## Comparing with the baseline

Each kind keeps lifetime tallies in `checkpoint.decisions.tally`: decisions, how many differed from the baseline, and the outcomes of agreeing and differing choices. Once a kind has 20 differing choices that succeed more than ten points less often than agreeing ones, Jev is no longer asked for that kind (`provider-underperforms-baseline`).

`bun run packages/ai/src/index.ts decisions --config <population.json>` reports a fleet summary (tallies summed per kind, and who decided each retained trace and why Jev was not asked) and per-resident tallies. Measured latency is about 250 ms median and 340 ms at the 90th percentile. In conversation tests Jev clearly outperformed the local rules: they looped on greetings and repeats where Jev did not. A population-scale comparison is still to run.

Related: [persistence](persistence.md).
