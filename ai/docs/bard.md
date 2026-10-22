# Bard

[Documentation index](README.md)

The bard (`src/bard.ts`) works the graveyards with music rather than steel. It carries no weapon skill; Musicianship trains with every song.

## Instrument

Without an instrument the bard walks to the nearest bard vendor (any city, with moongate travel) and buys one of the SBBard instruments (drums, tambourine, lap harp or lute, about 21 gold, at most 30). With no vendor or no purchase it records a `no-vendor` or `missing-tool` setback rather than quitting.

## In the cemetery

Each bard picks a ground from its profession's weighted `grounds` in `world/world.json` (Britain 2, Vesper 1, Yew 1), held for half an hour so bards spread out. In range of graveyard undead (the fighter's prey bodies, within ten tiles) it plays one skill per turn:

| Situation | Skill | How ServUO resolves it |
| --- | --- | --- |
| Something is attacking the bard | Peacemaking on itself | Calms everything in range |
| Two or more undead nearby | Provocation | The first is set on the second |
| One undead nearby | Discordance | Weakens it |
| None | — | Walks a random spot near the cemetery center |

A skill use answers ServUO's "What instrument shall you play?" cursor (500617) with the carried instrument when asked, then the skill's own target cursor(s). It waits out each skill's delay (Peacemaking and Provocation 10 s, Discordance 6 s) before the next use.

## Status

Built and running in populations through the profession runtime; progress counts calmed, provoked and discorded uses. Provoked fights are not looted, and the bard does not yet lead others to the undead it weakens.
