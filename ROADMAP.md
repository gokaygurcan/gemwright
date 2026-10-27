# Roadmap

Open work only. Finished work lives in the code, the package docs and the [changelog](packages/gemwright/CHANGELOG.md).

## Residents' life goal: stop the nonsense for good

> **Grow stronger and richer through your trade, without dying.**
> Better skills, more gold, less death: every resident, from its own trade, gear and skills.

Rules every resident follows:

- **Job first, every tick.** Supplies, bank trips, shopping and mounts only when they speed the job up and are affordable and reachable. Breaks and chatting only after real progress.
- **Survival limits risk; it never stops action.** A fighter with any melee weapon and enough health fights. Bandages and potions only shorten recovery; low health means retreat nearby and rest, never a shopping trip.
- **Live self-awareness.** Worn gear, backpack, gold, health and skills are read every tick from the client's current state, as a player sees their screen. Every decision reads that one view. The bank is remembered from its last look.

Steps:

- Baseline (`progress-report.ts`, 27 October 14:40–17:01 UTC, 250 residents): skills +725.5, gold +42,680, **98 deaths** (65 residents; 76 of them from 16:00, after that day's fight changes); productive 93, idle 76, died 65, looping 8, stranded 7. Rerun it the same way for step 5.
- [x] **1. One decision maker per resident** (built 27 October, not yet deployed), driven by the goal and the live view. Each trade's job and what it needs is written once. When the job is impossible, a fixed sequence runs: the bank spare, then buying it, then earning it in a way that works with no gear. Begging and waiting are not earning.
- [x] **2. Remember outcomes** (built 27 October, not yet deployed). An errand or destination that gains nothing is banned for 2 hours for that resident, saved across restarts. A teleporter back to where a walk started is never taken.
- [x] **3. A map of where you can walk** (built 27 October, not yet deployed; `build-areas.ts`). Built once from the map files, teleporters and moongates. Residents choose only places in their own connected area or through a gate they can reach. A stranded resident uses Recall or the stuck menu, or does its job where it stands.
- [x] **4. Loop guard** (built 27 October, not yet deployed; `loop-watch.ts`, analyzer Loops page). The same sequence 3 times, or 5 minutes without progress or a step toward its job, forces the resident back to its job, logged as `[loop]` and shown on a Loops page in the analyzer.
- [ ] **5. Done means better skills, more gold and fewer deaths, measured over a few hours after one deploy** (two database copies compared with `progress-report.ts --before`):
  - skills: the population's total skill points rise, and every resident below its skill goals gains some;
  - gold: the population's gold (carried and banked) rises, and every resident ends richer than it started, except for a recorded purchase of gear or supplies;
  - deaths: zero is the aim; any death is listed with where, what killed it and why it fought, and fixed;
  - no resident looping, stranded, or idle for more than 5 minutes (no progress and no step toward its job) outside a timed break; every resident named in reports (Orin Lake, Wesley Hill, Perrin Moss, Gavin Quill, Orin Vale, Owen Hill, Lucan Byrne, Quinn Ward, Edwin Ward and the Jhelom bank group) among them.

  Anything short of this is fixed or rolled back before it is reported as done.

## AI residents (`packages/ai`)

The goal: residents who live like players. They earn, spend and recover on their own and grow over weeks. They play for fun and progress, not because a loop says so, and they act realistically, not perfectly or predictably.

Live, 26 October 2026: 250 residents. Miners earn (median 6,100 gold, +85 an hour); most other trades are flat or losing gold; broke residents now fish for a living. 238 trades between residents (about 7,500 gold). No house, guild or dungeon run yet.

### Stop the nonsense

- [ ] Deaths on the road: confirm the death rate falls (`[death]` logs).
- [ ] Merrick Shaw carries 39 spare mining tools (19 refused to drop: "Timed out waiting for ground drop"): find what keeps buying or making tools, and make dropping them reliable.
- [ ] Failed walks to Britain's bank (1436,1692), Ethereal Goods (1498,1659) and around 1400,3744 in Jhelom: check those landmarks stand on reachable tiles.
- [ ] Confirm live:
  - tamers past Animal Taming 55, travelling to taming grounds (`tamer-travel`);
  - escorts paid (residents under 1,000 gold now walk to escort spawns);
  - spare crafted pieces sold from the bank in batches (Merrick Shaw: 84 kite shields);
  - on a pull, no death robe in any backpack (697 on 26 October, mostly fighters; fighters now tidy every turn);
  - healing others; picked-up armour worn (`[equip:]`); purchases from players' shops;
  - Jasper Shaw's fish-and-fail-to-sell loop in Moonglow;
  - resident sales at 60% of the shop price: garments from tailors (`buying-from-resident`), spare mounts and pack animals from tamers (`Offering the`); exceptional armour bought from smiths;
  - player parties (`Joined`), guiding (`guiding`), bandage resurrections (`raising`);
  - Jhelom's teleporters used on purpose (`teleporter:`), and nobody stranded on its islands;
  - broke fighters earning instead of failing setup (`earning`);
  - bulk orders taken by smiths and bowyers; side trades in wood and ore (`Chopping wood`, `Digging ore`), and the best payer chosen again;
  - lessons bought from savings (`training-travel`); prices leaning with supply; known and trusted sellers first;
  - drives behind life phases (`Next: … for money`); help remembered (`bandaged me`); greetings from shared memories; walking in crowds, pauses and slips;
  - `[trouble]` hotspots shrinking as routes detour; supply runs (`nearly out of ammunition`, `out of a combat reagent`); corpse runs; red calls heard and avoided; gossip in greetings.

### One mind, not many runners

- [ ] More thresholds into `packages/ai/tuning.json` as they get tuned.

### Depth players recognise

- [ ] Recall and scribes, confirm live: travel scrolls looted and learned (`Learned`), offered (`scroll` offers), written by scribes (`scribing`), runebooks bound and sold; runes marked (`marking`) and recalls (`recalling`), from runes or a runebook.
- [ ] Houses that get used: stored goods, a vendor, friends visiting (once a resident owns one).

### Fight with judgement

- [ ] Fight confidence, next: pulling one at a time; leaving a fight that turns bad; judging a brawling archer by Wrestling, not Archery; confirm "too risky" passes live.
- [ ] Progression that follows skill: grounds and prey rise with the weapon skill, not the highest skill. Training covers what the next stage needs (weapon skill, Magery with reagents, Healing with bandages), so no template is stuck with only Anatomy and Eval Int at 100.
- [ ] Parties: broke or weak fighters join better-geared residents, hunt together, and split the loot (`hunting-party.ts` is a start), instead of dying alone.

### An economy that moves

UO moved from a closed resource loop to faucets and sinks, tuned per item, because hoarding froze the closed loop ([Simpson](https://dergigi.com/assets/files/UO-Economics.pdf)). Follow that, within game rules.

- [ ] Most trades lose gold every day (save browser `/economy`: only miners and thieves gain). Find each trade's leak and close it; side trades, bulk orders and resident sales are the first answers.
- [ ] Reagents between residents, once someone gathers or sells them.

### Realistic, not coded

Believable bots are held back from perfect play, and differ from each other ([*The Many Challenges of Human-Like Agents*](https://arxiv.org/pdf/2505.20011); [2K BotPrize](https://phys.org/news/2012-09-artificially-intelligent-game-bots-turing.html)). Agents feel human with memory, reflection and plans ([*Generative Agents*](https://arxiv.org/pdf/2304.03442)).

- [ ] Jev against local at population scale (`/decisions`, half the residents ask Jev since 27 October): keep, widen or drop it on what the groups show.

Parked: one decision provider interface for any model (Jev, Claude, DeepSeek), chosen in config. Held: seeding a resident with 75,000 gold for a house, guild and player vendor (it would feel like deus ex machina); residents earn it.

Also open: thieves robbing grey and red players (needs the Thieves' Guild: Recall or boats); population tuning from player signals. Planned: resurrecting pets, other facets, power scrolls, guild sparring. Deferred: murderers, treasure hunts, boats.

## CLI (`packages/gemwright`)

- [ ] `gemwright ai <command>`: run the AI's commands (reports, residents, decisions) against the deployed resident database.
- [ ] Profession shares from `gemwright.json`.
- [ ] `gemwright restore`: a first real run against the live shard.
- [ ] AI residents for emulators other than ServUO.

Deferred: AI residents and restore on a VPS (and a real VPS deploy since the workspace restructure), and a restore drill into a separate Railway environment.

## Save browser (`packages/analyze`)

- [ ] House owners and guilds from the save, with house and guild pages.
- [ ] Status bonuses, resists, luck and damage (each character type's own save data).
- [ ] Mount and character drawn on the map (animation files); an isometric world view.

## Repository

- [ ] Checks on pull requests (lint, typecheck, tests), so release pull requests are checked too.
