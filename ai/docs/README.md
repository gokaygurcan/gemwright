# AI residents

Gemwright's AI runtime populates a ServUO shard with persistent characters that play like ordinary players: they log in through the normal client protocol, mine, chop, fish, hunt, tame, steal, play music, trade with vendors, bank, die and recover, and talk. Nothing runs inside the server and no character has privileges a player lacks.

Start here, then read only the topic you need. Paths in commands are relative to the repository root.

## Foundation

| Topic | Covers |
| --- | --- |
| [Design](design.md) | Goals, ordinary-player boundaries, architecture, reference projects. |
| [Commands](commands.md) | Every command, and the source layout. |
| [Templates and archetypes](templates.md) | Character templates, archetypes, temperament, allocation and revision rules. |
| [Persistence](persistence.md) | The resident database, checkpoints, credentials, skill snapshots, crash recovery. |
| [Sessions](sessions.md) | The headless client, ServUO profile and provisioning, protocol capabilities. |
| [Reconnect](reconnect.md) | Automatic reconnect and interrupted-encounter reconciliation. |
| [Population](population.md) | Running many residents, the world configuration, performance. |
| [Locations](locations.md) | The landmark catalog, terrain, stairs, doors and NPC approaches. |

## Behavior

| Topic | Covers |
| --- | --- |
| [Mining](mining.md) | The Minoc miner: mining, smelting, smithing, banking and tools. |
| [Lumberjack](lumberjack.md) | Trees, chopping, boards and the best value from wood. |
| [Fighter](fighter.md) | Cemeteries, opponents, damage-aware combat, parties, gear, loot, training. |
| [Dungeons](dungeons.md) | Dungeon runs alone or in parties, the crawl, party chat, catalogs and run records. |
| [Death and recovery](death-recovery.md) | Resurrection, corpse decisions, replacement equipment. |
| [Thief](thief.md) | Theft trips, hiding and stealth, snooping pack animals. |
| [Bard](bard.md) | Peacemaking, Provocation and Discordance in the graveyards. |
| [Mounts](mounts.md) | Buying, riding, care and stabling horses. |
| [Funds](funds.md) | Bank-charged purchases, town trips and income. |
| [Skill usage](skill-usage.md) | Where each skill is trained, idle practice, stat and skill locks. |
| [Experience](experience.md) | Remembered outcomes that make residents more careful. |

## Decisions and speech

| Topic | Covers |
| --- | --- |
| [Decisions](decisions.md) | Jev and the local rules: contract, budgets, traces, baseline comparison. |
| [Conversation](conversation.md) | Hearing, understanding and answering speech, between residents and with players. |

[Roadmap](roadmap.md) tracks milestones and what remains.

## Keeping documentation small

Update the topic a change belongs to; this index only lists topics. Every agent-authored file stays under 5,000 estimated tokens (bytes / 4, so 20,000 bytes, per the root `AGENTS.md`). Docs describe how things work now: dated run logs belong in commit messages, not here.
