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
- [x] Moving or standing ([conversation](conversation.md#moving-or-standing), `engagement.ts`): on the move a resident answers in a word or two (lowercase, sometimes mistyped) or not at all; replies take typing time; a player can stop a resident to talk, and while engaged every walk waits. "stop"/"wait" mean stop walking, player conversations reopen after a goodbye, a repeated greeting gets "Yes?".
- [x] Trade windows: a window a resident did not agree to is cancelled with one in-character line (`trade-guard.ts`); an engaged resident asked to trade quotes its largest market lot and answers that player's window with it.
- [x] Players' free-form talk (`player-trade.ts`): "wtb 50 boards", "heal pots?", "wts 40 ingots 4gp ea" read into side, good, amount and price (patterns, then Haiku when enabled, cached); a resident who stopped quotes from its stock (taking the player's price when it beats the shop), or buys what it uses (bowyers boards, archers exceptional bows, fighters potions, Tinkering trainees iron) within its carried coins, and answers that player's trade window with the agreed lot.
- [x] Phrasing follows the situation: authored terse lines on the move (no model call), Haiku-phrased full sentences once a resident has stopped to talk.
Other player-facing cooperation (players inviting and being followed by residents, commitments, conflicting requests) is deferred until there are players to test it with; the current party model is enough for now.

## 6. Gemwright integration — in progress

- [x] ServUO AI patch (`patches/servuo-pub57-ai.patch`): `--trusted-host` names are resolved every minute and exempt from per-IP account, connection and failed-login limits; applied only when the AI is deployed.
- [x] `gemwright deploy` parts: no flags or `--server` deploy the server; `--client` and `--ai` deploy exactly the named parts.
- [x] `--ai` on Railway (`src/ai-deploy.ts`): a `<shard>-ai` service and volume, built from `ai/Dockerfile`; `ai/src/serve.ts` keeps every resident online indefinitely (2-second login stagger; a finished or failed session logs back in); map files are uploaded to its volume; the shard trusts its private address.
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

- [ ] Pack animals for gatherers (`pack-animal.ts`, built, awaiting live evidence): miners and lumberjacks buy a pack horse or llama from the animal trainer once they ride, load ore and boards into its pack, and unload at the forge or carpenter. Every character gathers its pets (pack animal, unridden horse, tamer's companion) within 2 tiles before a public moongate (`pets.ts`), since only pets within 3 tiles go through.
- [x] Mage summons (`mage-combat.ts`, built, used once Magery allows: 57 for Summon Creature, 100 for the 8th circle): summon creature, the elementals and daemon are cast with mana to spare and a free follower slot, then sent at the opponent with "all kill"; blade spirits and energy vortex only on a spot with no human, resident, player or pet within eight tiles and the caster five or more tiles away. One summon at a time.
- Not planned: combat companions for fighters and mages. A companion is a liability, and waiting for it to catch up slows the character down.
- [x] Activity lifecycle ([life phases](population.md#life-phases)): work, dungeon, errands, leisure, visits and practice, configured time split (default balanced), temperament-shaded, at most five switches a minute.
- [x] Population spread and variety ([spread](population.md#spread)): homes, weighted grounds, life phases and visits, and destination choices that weigh how many residents are already there.
- [x] Calling guards on criminals and murderers in guarded towns (`guards.ts`): "guards" (keyword 0x0007) when a grey or red player is within twelve tiles inside a guarded region, as the server last reported it (500112/500113); bolder residents shout more readily.
- [x] Thieves sell their takings to town vendors while innocent before banking, and take stored takings back out to sell when the bank box nears ServUO's 125-item limit. Creatures are marks in graveyards and dungeons.
- [ ] Thieves rob grey and red players. ServUO requires the NPC Thieves' Guild (Stealing 60, no murders, not young, two days of game time, 500 gold); its only Trammel guildmaster is in Buccaneer's Den, so this waits for Recall or boats and for thieves with that much play time. Trammel forbids stealing from innocents; vendors and shopkeepers always refuse.
- [ ] Trading between residents (`market.ts`, `trade-deal.ts`, `protocol/trade.ts`; live for boards, built for potions): each good has a market town (boards Yew, potions Britain) where sellers and buyers meet at the bank, or at the good's shop in a town without one. Sellers shout their lot, buyers shout bids, a turn or two of fixed-shape speech agrees a lot price between the NPC shop's buying and selling prices (stance by temperament or Jev: `market-ask`, `market-bid`), and the deal closes in the secure trade window, paid in coins from the bank. Every attempt is logged (`trade_log`: role, partner, good, amount, price, market, completed) besides the trade totals in `activity`. Chains: lumberjack boards to bowyers; alchemist lesser heal, cure and poison potions (made by preference, held back from the shop, up to 20 each) to fighters living in Britain; miner iron ingots (Minoc) to Tinkering trainees near Minoc, who otherwise buy the tinker's 16-ingot stock. Buyers court one seller at a time and both sides ignore market lines older than 20 seconds. Not traded: arrows, which cost about 4.5 gold to make (a board's shaft and a 2-gold feather) against the bowyer's 2-gold price; smithed gear (needs per-item goods); tailor goods; players' free-form shouts.
- [x] Crafters buy raw materials from vendors and sell to vendors: tailors buy cloth (or uncut cloth and bolts, or spin wool) and sell garments to the tailor; smiths short of banked iron buy ingots from the blacksmith (5 gold) when the best recipe pays more per ingot, and sell the goods to the blacksmith.
- [x] Crafters choose recipes for profit (`chooseRecipe`): below their skill goal they train on the highest recipe, the loss capped by the hourly training budget; at the goal they craft only what pays (chance × vendor price − material, failures wasting half). At ServUO vendor prices bought cloth never pays, so a tailor at its goal waits for player trade. Thieves sell each kind of taking only where the offer is within a tenth of the best price seen.
- [x] Recipe catalogs (`catalogs/crafts/`, built by `src/build-crafts.ts` from ServUO's Def* craft systems and vendor sell lists): Blacksmithy 108 recipes, Carpentry 103, Tailoring 70, Tinkering 59, Alchemy 20, Bowcraft 11, each with skill range, material, extras (bottles) and vendor price. Alchemist and bowyer professions buy reagents and bottles, or boards, craft, and sell to their trades. Cartography, Inscription (reagents per scroll), Cooking beyond fish steaks and arrows and bolts (shafts and feathers) are not covered.
- [x] Crafters sell to players: an engaged resident asked to trade quotes and sells its lot in the player's window (`trade-guard.ts`).
- [x] Crafter shops found reliably: vendors searched within 18 tiles of the catalogued street point, the nearest town used when a town has none of that shop (Yew has no tinker); crafters for profit keep a 100-gold reserve and spend up to 1,000 an hour; alchemy results recognised; a crafter with nothing to make waits three minutes.
- [x] Residents who do not fight keep away from creatures that attack on sight (`danger.ts`, `catalogs/aggressive-bodies.json` from ServUO FightMode; bodies shared with passive animals judged by name), criminals and murderers: unsafe trees and rocks are skipped, unsafe areas remembered for 20 minutes, and they head back to town when one comes within eight tiles. Vendors, passive animals and pets are fine company.
- [x] Loose items picked up everywhere (`scavenge.ts`): at work, in town phases, and within reach while walking; gold, gems, reagents, potions, scrolls, ammunition, crafting materials, tools, instruments, fish, books and anything wearable.
- [x] Bards loot the gold of undead they provoke (`bard-loot.ts`).
- [x] Iron ingot market: miners with 150+ banked ingots offer lots at the Minoc bank; Tinkering trainees near Minoc buy there, else from the tinker.
- [x] Item quality (`item-quality.ts`): artifact, blessed, magic, exceptional and normal told apart from the property list a player sees on hover; only normal items are sold to shops (crafters, fighters' loot, thieves' takings), the rest are kept, banked or traded to residents.
- [x] Bowyers make bows and composite bows: normal ones go to the bowyer, exceptional ones stay in the pack and are offered at the Yew market (`exceptional bows`, 28-80 gold); archers now and then buy one there and wield it.
- [x] No bowyer homes in Skara Brae (its bowyer cannot be found); bowyers live in Yew and Britain.
- [x] Miners leave a rock for town when an attacking creature comes within eight tiles mid-dig.
- [x] Travel by the actual roads between towns: the offline corridor build (`build-routes.ts`) charges an off-road step twice a road step, so stored routes between Britain, Yew, Cove, Vesper, Minoc and Trinsic keep to the roads (about half their steps on road tiles, against 13–31% before); walks over 96 tiles join those corridors before trying a straight line.
- [x] Record what residents notice about real players (`player_signals`, `activity.ts`): market lines players say (good, amount, price), trade windows players open on residents, and speech aimed at a resident (when and where, never the words). Each event once, however many residents heard it; residents (the roster) and NPC vendors are not players.
- [x] Player signals in resident behavior (`player-insight.ts`, each with a minimum sample, cached ten minutes): market stances follow the median unit price players named for a good this week (five or more), crafters make first what players asked to buy (three asks or more), and towns where players were heard in the last day draw visits up to twice as much. Free-form trade talk is recorded as market signals too.
- [ ] Population-level tuning from activity, trades and player signals: periodic reports proposing small, reversible `world.json` changes (profession shares, homes, grounds, market towns), approved before they apply, each with a minimum sample and a cap. Needs more players.
- [ ] Player signals in Jev's decision state, so choices reflect real player behavior within the existing guards and cost cap. Needs a lot of data.
- [ ] Backups and restore drills.
- [x] Measure long-running populations (`report.ts`): population and uptime (residents online, memory, worst event-loop lag, stalls, sampled every five minutes into `population_metrics`), activity totals and hourly rates, gold, skill spread, trades by good and why deals failed (`trade_log.reason`), horses and pack animals, Jev spend, dungeon runs and player signals. Runs on a database copy or in the AI container.

Deferred: murderers (PKs) and criminal actions against players and residents; treasure hunts; guilds, Order/Chaos wars, boats, housing and storage.

## Planned

- **Dungeons** are built and await live evidence ([dungeons](dungeons.md)): solo at 100.0 primaries, parties sized by the weakest member from 80.0, a crawl after UO Offline's, party chat between members, and a record of every run and party (`dungeons` report). Fighters, tamers, bards and thieves all take part; dead members are raised by a party healer (bandages or the Resurrection spell) or climb out and come back for their corpses; a dead leader hands the party on. Next: Recall for island dungeons, resurrecting pets.
- **Other facets:** Felucca, Ilshenar, Malas and Tokuno need map assets and location catalogs.
- **Skills above 100** need power scrolls from champion spawns, so they wait for Felucca and dungeons.
- **Sparring** for passive skills waits for guild support (deferred).

## Verification

Unit tests cover configuration, allocation, revisions, decision candidates, protocol framing and focused behavior rules; SQLite tests cover persistence and interrupted writes; local socket tests cover sessions. Behavior is otherwise validated live on a shard. An action counts as done only when server feedback or the resulting observations confirm it, never because a request was sent.
