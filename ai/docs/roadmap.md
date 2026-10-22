# Roadmap

[Documentation index](README.md)

Checkboxes mark implementation; acceptance criteria say when a stage is complete. "Awaits live evidence" means built and checked locally but not yet observed on a shard.

## 1. Templates, persistence and allocation — done

- [x] Versioned templates, archetypes and temperament; deterministic weighted and fixed allocation.
- [x] Stable residents with creation and policy revisions, bindings and checkpoints; transactional reconciliation that parks rather than deletes.
- [x] Shard, revision and stale-write protection; recovery from an interrupted write.
- [x] Credentials and hourly skill snapshots in the resident database.

Acceptance: reconciliation is idempotent; scaling down and up keeps identities and progress; template updates never reset characters; invalid updates leave no partial changes.

## 2. Headless client — done for ServUO

- [x] Ordinary login, character creation and play over the classic 7.0.45.1 protocol, with no privileged access.
- [x] Movement, speech, items, targeting, gumps, vendors, parties, skills and spells ([sessions](sessions.md)).
- [x] Runtime lease, reconnect with backoff, clean shutdown.
- [x] ServUO profile and provisioning from the shard's `gemwright.json`.

Other emulators are out of scope for now.

## 3. Gatherer and adventurer loops — done, some branches await live evidence

- [x] Mining, smelting, smithing and banking; lumberjacking; fishing and cooking; tailoring.
- [x] Graveyard fighting for swordsman, fencer, mace fighter, archer and mages, with damage-aware tactics, looting, selling and training.
- [x] Death, resurrection at the closest healer or ankh, corpse decisions, replacement equipment.
- [x] Horses: buying, riding, dismounting to work, care and stabling.
- [x] Reconnect and interrupted-encounter reconciliation; world-condition failures are setbacks, never a reason to quit.
- [x] Tamer with a fighting pet and the archery tamer; bard; thief; poisoned fencer blades; worn-gear replacement.

Awaiting live evidence: pet combat and the archery tamer, poisoned blades, worn-gear replacement, the thief review fixes, poisoned and stabled mounts, locked doors and unreachable opponents, safe-corpse transfers and buying a missing weapon after death.

Acceptance: residents repeat their loops across restarts without duplicating transactions or gaining free resources; an impossible situation ends in a visible, explainable outcome.

## 4. Decisions with Jev — in progress

- [x] Provider, guards, budgets, traces, experience and checkpoint migrations ([decisions](decisions.md)).
- [x] Decisions for activity, opponents, tactics, town trips, corpse recovery, parties and speech.
- [ ] Compare Jev with the baseline at population scale (`decisions/jev-compare.example.json`, `decisions` report). Conversation tests already favour Jev.

Acceptance: different templates make coherent, measurable choices; recent outcomes change later ones; a model outage leaves everyone working on local rules; no model answer bypasses server rules.

## 5. Conversation and cooperation — in progress

- [x] Residents talk with players and each other: intent, addressee and reply chosen by Jev; repeats, pauses, caps, goodbyes, stop words and quiet periods handled ([conversation](conversation.md)).
- [x] Resident parties with spoken plans, refusals and sitting a fight out.
- [x] Phrasing by Claude Haiku 5.5 on top of the authored replies, guarded and cached ([conversation](conversation.md#phrasing-with-claude)).
Player-facing cooperation (players inviting and being followed by residents, commitments, trading, conflicting requests) is deferred until there are players to test it with; the current party model is enough for now.

## 6. Gemwright integration — in progress

- [x] ServUO AI patch (`patches/servuo-pub57-ai.patch`): `--trusted-host` names are resolved every minute and exempt from per-IP account, connection and failed-login limits; applied only when the AI is deployed.
- [x] `gemwright deploy` parts: no flags or `--server` deploy the server; `--client` and `--ai` deploy exactly the named parts.
- [x] `--ai` on Railway (`src/ai-deploy.ts`): a `<shard>-ai` service and volume, built from `ai/Dockerfile`; `ai/src/serve.ts` runs the population in hour-long rounds; map files are uploaded to its volume; the shard trusts its private address.
- [x] `ai` settings in `gemwright.json`: `population` (0–250) and `decisions` (`local` or `jev`).
- [x] First live Railway deployment (2026-10-22): `gemwright deploy --server --ai` with 250 residents and local decisions; the AI service keeps its own resident database on its volume, so the population started fresh. Later changes ship with `--ai` alone.
- [ ] `gemwright ai <command>`; profession shares from `gemwright.json`.
- [ ] VPS, now that Railway is seen working.

Agreed plan:

1. `ai/` ships as a deployable part of the `gemwright` package, like `client/`, with its own container and volume (the resident database and map assets).
2. AI settings live under an `ai` key in the shard's `gemwright.json` (population cap, profession shares, decision provider); the Jev key is a deployment secret.
3. `gemwright deploy --server --client --ai`, in any combination. With no flags, `gemwright deploy` deploys the server as today; `--server` says the same explicitly.
4. `gemwright ai <command>` runs the AI commands locally or inside the deployed container.
5. A ServUO patch, applied only when the AI is deployed, lets the AI's address exceed the per-IP account limit.

The AI reaches ServUO over Railway's private network, and the deployment writes its connection settings.

## 7. Full coverage and operation — later

Residents are ordinary players: everything they do is something any player can do over the protocol, and the other way round. No spawning, deleting, teleporting or server-side help; stragglers catch up or use party chat, ghosts find their own way. Residents stay online all the time; there are no login sessions or daily curves.

- [ ] Pets for archetypes other than the tamer.
- [x] Activity lifecycle ([life phases](population.md#life-phases)): work, dungeon, errands, leisure, visits and practice, configured time split (default balanced), temperament-shaded, at most five switches a minute.
- [x] Population spread and variety ([spread](population.md#spread)): homes, weighted grounds, life phases and visits, and destination choices that weigh how many residents are already there.
- [x] Calling guards on criminals and murderers in guarded towns (`guards.ts`): "guards" (keyword 0x0007) when a grey or red player is within twelve tiles inside a guarded region, as the server last reported it (500112/500113); bolder residents shout more readily.
- [x] Thieves sell their takings to town vendors while innocent before banking, and take stored takings back out to sell when the bank box nears ServUO's 125-item limit. Creatures are marks in graveyards and dungeons.
- [ ] Thieves rob grey and red players. ServUO requires the NPC Thieves' Guild (Stealing 60, no murders, not young, two days of game time, 500 gold); its only Trammel guildmaster is in Buccaneer's Den, so this waits for Recall or boats and for thieves with that much play time. Trammel forbids stealing from innocents; vendors and shopkeepers always refuse.
- [ ] Trading by shout: a buyer yells what it wants, residents nearby who have it answer, sellers undercut each other, and the deal closes in the real trade window.
- [x] Crafters buy raw materials from vendors and sell to vendors: tailors buy cloth (or uncut cloth and bolts, or spin wool) and sell garments to the tailor; smiths short of banked iron buy ingots from the blacksmith (5 gold) when the best recipe pays more per ingot, and sell the goods to the blacksmith.
- [x] Crafters choose recipes for profit (`chooseRecipe`): below their skill goal they train on the highest recipe, the loss capped by the hourly training budget; at the goal they craft only what pays (chance × vendor price − material, failures wasting half). At ServUO vendor prices bought cloth never pays, so a tailor at its goal waits for player trade. Thieves sell each kind of taking only where the offer is within a tenth of the best price seen.
- [x] Recipe catalogs (`catalogs/crafts/`, built by `src/build-crafts.ts` from ServUO's Def* craft systems and vendor sell lists): Blacksmithy 108 recipes, Carpentry 103, Tailoring 70, Tinkering 59, Alchemy 20, Bowcraft 11, each with skill range, material, extras (bottles) and vendor price. Alchemist and bowyer professions buy reagents and bottles, or boards, craft, and sell to their trades. Cartography, Inscription (reagents per scroll), Cooking beyond fish steaks and arrows and bolts (shafts and feathers) are not covered.
- [ ] Crafters sell to players; waits for trading by shout.
- [ ] Travel by the actual roads between towns on the same landmass, not the shortest cross-country line: today road tiles are only slightly cheaper (1 against 1.12 in `path-search.ts`) and the stored corridors are fastest routes.
- [ ] Backups and restore drills.
- [ ] Measure and collect data: model cost, shard impact, outcomes of long-running populations. Short runs pass at 100–250 clients ([population](population.md)).

Deferred: murderers (PKs) and criminal actions against players and residents; treasure hunts; guilds, Order/Chaos wars, boats, housing and storage.

## Planned

- **Dungeons** are built and await live evidence ([dungeons](dungeons.md)): solo at 100.0 primaries, parties sized by the weakest member from 80.0, a crawl after UO Offline's, party chat between members, and a record of every run and party (`dungeons` report). Fighters, tamers, bards and thieves all take part; dead members are raised by a party healer (bandages or the Resurrection spell) or climb out and come back for their corpses; a dead leader hands the party on. Next: Recall for island dungeons, resurrecting pets.
- **Other facets:** Felucca, Ilshenar, Malas and Tokuno need map assets and location catalogs.
- **Skills above 100** need power scrolls from champion spawns, so they wait for Felucca and dungeons.
- **Sparring** for passive skills waits for guild support (deferred).

## Verification

Unit tests cover configuration, allocation, revisions, decision candidates, protocol framing and focused behavior rules; SQLite tests cover persistence and interrupted writes; local socket tests cover sessions. Behavior is otherwise validated live on a shard. An action counts as done only when server feedback or the resulting observations confirm it, never because a request was sent.
