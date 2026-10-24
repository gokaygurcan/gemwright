# Thief

[Documentation index](README.md)

The thief (`src/thief.ts`, `src/thief-actions.ts`, `src/thief-skills.ts`, `src/thief-marks.ts`) lives in its home town without a mount and takes theft trips to the cemetery nearest home. It never takes from players, town NPCs, vendors or fellow residents. Between trips it practises its quiet skills.

## A trip

1. **Walk to the ground.** The thief walks to the nearest cemetery (with moongate travel when it is far). The trip's five working minutes start on arrival.
2. **Pick a mark.** Only a lone zombie (body 3) or skeleton (bodies 50 and 56) with no other undead within eight tiles, and at most 60 hit points, is a mark. Its single-click name is checked first, so a stronger creature sharing the body is never approached.
3. **Hide, then sneak.** Hiding and Stealth each take one shared ten-second skill window. With a stealth budget (Stealth ÷ 5 steps on AOS) the thief walks in hidden. Below Stealth's Hiding requirement (30, 50 or 80 by expansion), Stealth refuses and reveals, so the thief walks in openly until Hiding has risen.
4. **Steal.** Both hands must be free. Stealing a mobile takes a random item from its pack. ServUO answers with success, failure, "too heavy", or nothing at all for an empty pack.
5. **Break away.** The thief retreats 14–22 tiles from the mark straight after the attempt, and from any visible undead that comes within six tiles. While hidden, nearby undead are not a chase.
6. **Bank.** After two thefts, six attempts, four failures, a heavy pack, low health or the five minutes, it walks home, drops graveyard refuse on the way, and banks everything but its spellbook and reagents.

## Selling the takings

Back home with takings, an innocent (blue) thief offers them to the town's jeweler, weaponsmith, blacksmith, tailor, mage, alchemist, bowyer and tinker before banking (`sellTo`), and banks the gold and whatever no vendor bought. A grey thief waits for its flag to clear. When the bank box holds 100 or more stored items (ServUO allows 125), up to 20 come back out to be sold on the next trip.

Stealing from players needs the NPC Thieves' Guild (Stealing 60, no murders, not young, two days of game time, 500 gold); the only Trammel guildmaster is in Buccaneer's Den, which residents cannot reach yet, and Trammel forbids stealing from innocents anyway.

## Snooping

Snooping is not a skill use: double-clicking another mobile's container runs the check (ServUO `Snooping.cs`). For a player, ServUO opens only a pack horse's or pack llama's strong backpack; every other creature pack is refused without a reply, and town NPCs and players refuse the peek. Between trips the thief cases pack animals within 18 tiles, once each.

## Replies on the pinned shard

Every reply is a cliloc observed in the journal, listed in `src/thief-skills.ts`: stealing (502723 failure, 502724 success, 1005584 hands not free, 502703 too far), hiding (501240 hidden, 501238 busy), stealth (502730 moving quietly, 502726 not hidden well enough, 502727 too much armor), snooping (500210 failed peek). An unanswered action is never replayed.

## Status

Built and running in populations through the profession runtime. A review fixed retreating from its own mark while hidden, snooping packs ServUO refuses, the missing armor refusal, the trip clock starting in town, and hiding uselessly below Stealth's requirement. Those fixes await live evidence.
