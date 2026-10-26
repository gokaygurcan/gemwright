# AI residents

Gemwright's AI runtime populates a ServUO shard with persistent characters that play like ordinary players: they log in through the normal client protocol, mine, chop, fish, hunt, tame, steal, play music, trade with vendors, bank, die and recover, and talk. Nothing runs inside the server and no character has privileges a player lacks.

Start here, then read only the topic you need. Paths in commands are relative to the repository root. Open work is in the repository's [roadmap](../../../ROADMAP.md).

## Principles

- **Ordinary players.** Residents connect over the ordinary client protocol (ServUO, classic 7.0.45.1) from a separate process. No server hook, privilege, free resurrection, resource injection or hidden-world knowledge: the server validates everything they do.
- **Observed state.** A resident knows what a player could: what it received, the public map, and its own memory. An action counts as done only when the server's feedback confirms it.
- **Bounded decisions.** Code offers Jev a closed set of candidates and checks the answer before acting; a model outage leaves everyone on local rules.
- **Secrets stay out.** Game-account credentials live only in the resident database; API keys only in the environment. Neither reaches templates, checkpoints, logs or model state.

## Foundation

| Topic | Covers |
| --- | --- |
| [Commands](commands.md) | Every command, and the source layout. |
| [Templates and archetypes](templates.md) | Character templates, archetypes, temperament, allocation and revision rules. |
| [Persistence](persistence.md) | The resident database, checkpoints, credentials, skill snapshots, crash recovery. |
| [Sessions](sessions.md) | The headless client, ServUO profile and provisioning, protocol capabilities. |
| [Reconnect](reconnect.md) | Automatic reconnect and interrupted-encounter reconciliation. |
| [Population](population.md) | Running many residents, the world configuration, performance. |
| [Locations](locations.md) | The landmark catalog, terrain, stairs, doors and NPC approaches. |

## Behavior

What residents do lives in the code, one module per trade or activity (`src/fighter.ts`, `src/miner.ts`, `src/profession.ts`, `src/escort.ts` and so on), not in design docs here: docs that described past decisions as the plan kept repeating them. Where each skill is trained is the owner's [skill usage guide](skill-usage.md). Open work and the direction are in the [roadmap](../../../ROADMAP.md).

## Decisions

| Topic | Covers |
| --- | --- |
| [Decisions](decisions.md) | Jev and the local rules: contract, budgets, traces, baseline comparison. |

## Keeping documentation small

Update the topic a change belongs to; this index only lists topics. Every agent-authored file stays under 5,000 estimated tokens (bytes / 4, so 20,000 bytes, per the root `AGENTS.md`). Docs describe how things work now: dated run logs belong in commit messages, not here.
