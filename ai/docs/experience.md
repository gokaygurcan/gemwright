# Experience that changes decisions

[Documentation index](README.md)

Each resident keeps bounded, structured observations in `checkpoint.experience`. This is separate from decision traces: choosing to fight is a trace; receiving damage and withdrawing is experience. The ordinary client remains the source of observations. Memory grants no knowledge of hidden enemy stats, vendor inventories, or remote terrain changes.

## What is remembered

- Combat: encountered body type, facet and encounter location, confirmed victory, retreat, death, or interrupted observation; largest observed hit, lowest health ratio, and gross damage relative to maximum health. Damage belongs to the encounter context, not a claim that a particular opponent caused every hit.
- Self-bandaging: server completion or failure, or unknown after an unconfirmed timeout, with reported Healing skill. Cure attempts are excluded from this healing record. Completion does not establish how much health a bandage restored.
- Recovery: completed or abandoned personal corpse collection, failed short recovery breaks, and accepted re-engagement after a break.
- Services: observed vendor serial and position, requested action, confirmed transaction/access, unavailable interaction, unreachable approach, absent context action, or observed absence of requested stock. Insufficient money or an expensive item does not mean a vendor is empty.

Encounter IDs permit death reconciliation to update the same event after reconnect. An uncertain continuation cannot overwrite an already confirmed combat outcome with an interruption. A refused attack with no damage does not teach that the enemy is powerful. Network loss is not a combat defeat. Unconfirmed healing timeouts are excluded from healing reliability.

## Current effects

The fighter compares recent encounters with the same body type, on the same facet, within 64 tiles. A death avoids that encounter area/type for ten minutes; a retreat after a hit of at least 35% maximum health avoids it for five minutes. If all observed targets are excluded, the fighter returns to town and waits before reconsidering. Adverse encounters also add caution that decays over 24 hours, bounded at 0.6. Among eligible targets, distance plus learned caution determines preference. A victory is recorded but never grants permission to exceed the template's risk tolerance.

Local combat assessment subtracts learned caution from the configured risk tolerance. Three or more comparable-skill bandaging outcomes with fewer than 25% completions subtract another 0.15. These adjustments only make the existing damage and emergency rules more conservative. Healing skill differences greater than ten points exclude old known-skill outcomes; six-hour-old results expire from the reliability calculation.

Observed successful service providers receive a small distance preference. Failed interactions temporarily exclude that vendor/action; repeated failures extend the cooldown from one minute up to five minutes, and unreachable approaches receive five minutes immediately. Stock failures are specific to the requested graphic set, so a shop lacking potions is not excluded when looking for a sword. A confirmed later success clears the relevant cooldown. Both fighters and miners consult service experience; supported success/failure recording is attached to their actual service paths, rather than inferred from travel alone.

Jev receives a bounded derived summary alongside its existing state: at most four encounter profiles, healing counts, three recovery outcomes, and four service outcomes. It does not receive the full event store. Local target guards and emergency checks still override model choices. The local provider uses the same executor memory and requires no API calls.

## Caster losses

A retreat that drove health below 45% or included a single hit of 30% or more sets a 15-minute avoidance for that body near that place. Two or more dangerous outcomes against the same body within the day extend it to an hour after the latest. Avoided opponents are ignored while the fighter keeps hunting others; it no longer waits in town for the cooldown. The original 0.35 single-hit threshold let Bram re-engage body 26 (wraith after spectre) immediately after a 0.34 hit.

## Persistence and limits

Memory schema version 1 is optional on older checkpoints and initializes to an empty store. Unknown versions fail explicitly. Existing SQLite checkpoint transactions and revision checks persist it without changing resident identities or creation settings.

| Kind | Maximum events | Retention |
| --- | ---: | --- |
| Combat | 24 | Seven days |
| Bandage | 24 | One day |
| Recovery | 16 | Three days |
| Service | 32 | One day |

Initialization and writes prune expired and future-dated events, deduplicate IDs, and retain the newest events within each quota. Advice uses shorter windows where appropriate. Restarting does not reset caution or retry deadlines. A successful route is not yet a reusable route memory: existing observed forge landmarks remain separate. Relationship learning and social commitments remain later work.

