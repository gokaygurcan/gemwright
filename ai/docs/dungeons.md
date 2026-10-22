# Dungeons

[Documentation index](README.md)

Fighters, tamers, bards and thieves whose two primary skills reach 80.0 also run Trammel's dungeons. Craftsmen, fishermen and tailors never do (`progression.ts`). The model follows [UO Offline](https://github.com/Klein187/uo-offline)'s crawler, done the way an ordinary client would do it.

Awaiting live evidence: everything on this page has been checked locally (types, unit tests, catalog checks) but not yet observed on a shard.

## Who goes, and with whom

When a ready fighter leaves town for the hunt, half the time it goes to a dungeon instead of a cemetery. A tamer with a companion, a bard with an instrument and a thief consider a run every twenty minutes, with the same odds (`dungeon-turn.ts`, `profession-dungeon.ts`). Professions mix freely in a party.

| Primaries | Run |
| --- | --- |
| Both at 100.0 | Alone (`soloDungeons`). |
| Both at 80.0 or more | In a party: joins one being mustered within reach, or musters its own. |

A party's size follows its weakest member: 5 at 80.0, 4 around 88–92, 3 near 100.0 (`partySize`). The leader shouts `LFG <dungeon>, need N more` in town; ready residents in reach answer "me", walk over and accept a real ServUO party invitation. The muster lasts three minutes, then the party goes with whoever came. A short-handed party descends less, in proportion to how many came. A leader nobody joined says so, records the attempt as abandoned and hunts the cemetery as usual.

## The crawl

`dungeon-crawl.ts` (solo or leader):

1. Picks one of the home town's two nearest dungeons, or a fifth of the time any other (`chooseDungeon`), and a run of 20–45 minutes.
2. Walks to the nearest entrance, through its moongate when far, and steps onto the entrance teleporter.
3. On each floor it rolls the next goal: an unvisited room weighs 1, a visited one 0.15, and each stairway down from 0.5 at 80.0 to 2.0 at 100.0, so depth thins out (`rollGoal`).
4. Walking stops for any creature that closes within three tiles. In a room the character does its role's work (below) until there is nothing left to do in view.
5. The run timer, a hard town need (weight, healing supplies, health) or a retreat switches to exit mode: the nearest stairway up, floor by floor, defending only.
6. On the surface the run is recorded and the character goes back to town: a fighter sells and banks, a thief banks its takings.

A character found inside a dungeon after a restart climbs out.

## Roles

Every role targets whatever lives in the dungeon, from the full monster catalog, not the graveyard's undead.

| Role | Work in a room |
| --- | --- |
| Fighter (`fighter-dungeon.ts`) | Fights the nearest creature it can take, heals in the field. One too strong puts the room on the avoided list for the run. |
| Tamer (`tamer.ts`) | Sends its companion at any creature not rated never-engage, keeps it within three tiles so it goes through stairways with its master (ServUO `TeleportPets`). |
| Bard (`bard.ts`) | Peacemaking when attacked, Provocation on two creatures, and in a party Discordance on a lone one. |
| Thief (`thief-actions.ts`) | Hides, sneaks and steals from a lone weak creature of any kind: no spells, at most 80 health and 12 damage, no stronger creature within eight tiles (`dungeonMark`). |

## Deaths

`dungeon-death.ts`. A ghost in a party with another member still alive manifests (war mode, so the living can see it; ServUO `Mobile.CanSee`), says `res pls at x,y` in party chat and waits by its corpse. A member who can raise it answers `coming` and walks over: with Healing and Anatomy at 80.0 and bandages it bandages the ghost (ServUO `Bandage.cs`); otherwise with Magery at 80.0, 50 mana, bloodmoss, garlic and ginseng and Resurrection in its spellbook it casts the spell next to the ghost (`ResurrectionSpell`; a fizzle is cast again, and "You do not have that spell!" rules the caster out). Either way the ghost accepts the resurrection offer, takes back everything from its corpse, dresses, and carries on. A raised leader keeps leading. Nobody answers within twenty seconds:

- A leader hands the party to a living member (`<name> leads now`); that member crawls on as leader. The old leader stays in the ServUO party, since a leader leaving disbands it.
- With nobody else alive the party is over (`all dead, everyone head out`).
- The ghost climbs out floor by floor and is resurrected at the nearest healer or ankh ([death and recovery](death-recovery.md)), then goes back down over the stairways for its corpse: fighters through their usual recovery, the others through `recoverDungeonCorpse`, at most twice and within eight minutes, since player corpses decay after seven. Then it climbs out and heads to town.

## Opponents

Dungeon creatures get the graveyard's risk tiers from their ServUO stats (`fighter-prey.ts`), calibrated on the undead: zombie and skeleton are common, ghoul a brute, spectre a caster, bone knight and mummy knights, lich a lich. Creatures with more than 330 average health, resist of 150 or more, fame of 15,000 or more, unknown stats, or a human body are never engaged: dragons, daemons, balrons, wyrms and the named event creatures among them. Random-named kinds (orcs, ratmen, evil mages) are recognised by body. Fellow party members lower the requirements as they do in the graveyard.

## Parties under way

The registry in `dungeon-party.ts` only coordinates who joins. Once under way, members learn where the leader is from party chat, as players do (`dungeon-follow.ts`):

| Leader says | Meaning |
| --- | --- |
| `in at x,y` | Entering; members waiting at the entrance follow. |
| `down at x,y`, `up at x,y`, `out at x,y` | Taking that stairway. The leader waits up to 45 seconds (4 minutes at the entrance) for the group within six tiles. |
| `at x,y` | Answer to a member's "where are you?". |
| `<name> leads now` | The dead leader handed the party on. |
| `gg all, heading back to town`, `all dead, everyone head out` | The run is over; members climb out. |

Members walk to the entrance on their own and say "here". Inside, a member stays with the leader while it can see them and works beside them; out of sight it takes the stairway the leader last announced, or asks where they are. A member lost for five minutes, out of supplies, too hurt, or dead with nobody to raise it heads out on its own and says so; the leader stops waiting for it. Party chat is limited to 128 characters by ServUO; ordinary conversation ignores it.

Party chat is ServUO's `0xBF 0x06` subcommand 4 (to all members), received as subcommand 3 or 4 with the sender's serial; it lands in the journal marked `party`.

## Data

| File | Built by | Source |
| --- | --- | --- |
| `catalogs/dungeons/*.json` | `src/build-dungeons.ts` | ServUO `Data/Regions.xml`, `Data/teleporters.csv`, `Spawns/trammel.xml`, revamped Despise gates; client map files |
| `catalogs/monsters.json` | `src/build-monsters.ts` | ServUO `Scripts/Mobiles` constructors |

```sh
bun run ai/src/build-dungeons.ts --servuo <ServUO> --assets <client files> --output ai/catalogs/dungeons
bun run ai/src/build-monsters.ts --servuo <ServUO> --dungeons ai/catalogs/dungeons --output ai/catalogs/monsters.json
```

Floors are walkable areas flood-filled from the map files (keyed by height too, since levels overlap); stairways are teleporter groups between floors; rooms are spawner sites with their creatures; each floor's depth counts stairways from the entrance. Each surface entrance stores the nearest moongate it can be walked to from; entrances no gate reaches are dropped (Deceit, Hythloth and Fire need a boat or Recall). Eight dungeons are reachable: Covetous, Despise, Destard, Ice, Orc Cave, Shame, Wrong and the Britain and Trinsic entrances of "Misc Dungeons". Terathan Keep, entered on foot in the Lost Lands, has no teleporter entrance and is not run yet. Floors nothing reaches (revamped Despise's event level) are left out, and Khaldun, which needs a quest, is skipped at runtime.

## Records

Every run is a row in the resident database (`dungeon_runs`, schema version 4): resident, party, role, dungeon, planned size, members and their primary skills, whether the party assembled, start and end, outcome, deepest floor, kills and deaths.

```sh
bun run ai/src/index.ts dungeons --config <population.json>
```

reports per dungeon the solo runs and how many succeeded, parties assembled, abandoned and succeeded, kills and deaths, and the recent parties and solo runs. A run succeeded when it climbed out with nobody dead.

## Not yet

- Residents never Recall or sail, so island dungeons are out of reach.
- Resurrection is an eighth-circle scroll vendors do not sell; a mage has it only once it looted the scroll into its book.
- A tamer's dead companion is not resurrected.
