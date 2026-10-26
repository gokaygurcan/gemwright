# Roadmap

Open work only. Finished work lives in the code, the package docs and the [changelog](packages/gemwright/CHANGELOG.md).

## AI residents (`packages/ai`)

The goal: residents who live like players. They earn, spend and recover on their own and grow over weeks. They play for fun and progress, not because a loop says so, and they act realistically, not perfectly or predictably.

Live, 26 October 2026: 250 residents. Miners earn (median 6,100 gold, +85 an hour); most other trades are flat or losing gold; broke residents now fish for a living. 238 trades between residents (about 7,500 gold). No house, guild or dungeon run yet.

### Stop the nonsense

- [ ] Deaths on the road: confirm the death rate falls (`[death]` logs).
- [ ] Unreachable and dangerous targets get another target; remaining in-memory timers survive restarts.
- [ ] Tamers stall at Animal Taming 55: know where animals of their level live and go there.
- [ ] Confirm live:
  - escorts paid (escorts are found, but most trips are refused or the escort is not reached);
  - spare crafted pieces sold from the bank in batches (Merrick Shaw: 84 kite shields);
  - on a pull, no death robe in any backpack (697 on 26 October, mostly fighters; fighters now tidy every turn);
  - healing others; picked-up armour worn (`[equip:]`); purchases from players' shops;
  - Jasper Shaw's fish-and-fail-to-sell loop in Moonglow.

### Fight with judgement

- [ ] Fight confidence, next: pulling one at a time; leaving a fight that turns bad; judging a brawling archer by Wrestling, not Archery; confirm "too risky" passes live.
- [ ] Progression that follows skill: grounds and prey rise with the weapon skill, not the highest skill. Training covers what the next stage needs (weapon skill, Magery with reagents, Healing with bandages), so no template is stuck with only Anatomy and Eval Int at 100.
- [ ] Parties: broke or weak fighters join better-geared residents, hunt together, and split the loot (`hunting-party.ts` is a start), instead of dying alone.

### An economy that moves

UO moved from a closed resource loop to faucets and sinks, tuned per item, because hoarding froze the closed loop ([Simpson](https://dergigi.com/assets/files/UO-Economics.pdf)). Follow that, within game rules.

- [ ] Bulk orders: confirm a tailor's turn-in live; then smiths, alchemy, carpentry, fletching, tinkering and cooking.
- [ ] More side trades: lumberjacking, mining.
- [ ] More goods between residents: bandages, reagents, arrows, armour, cloth. Prices follow supply, and a market remembers who sells what.
- [ ] Sinks worth earning for: houses, better gear, mounts, training, guild life.
- [ ] Economy report per pull: per trade and day, and goods made, sold and used.

### Realistic, not coded

Believable bots are held back from perfect play, and differ from each other ([*The Many Challenges of Human-Like Agents*](https://arxiv.org/pdf/2505.20011); [2K BotPrize](https://phys.org/news/2012-09-artificially-intelligent-game-bots-turing.html)). Agents feel human with memory, reflection and plans ([*Generative Agents*](https://arxiv.org/pdf/2304.03442)).

- [ ] A goal layer above the trades: needs (health, money, gear, safety, friends, fun, progress) pick what to do next, with personal weights and some randomness, so two residents in the same spot do different things.
- [ ] Memory that changes behaviour: where it died and to what, what paid, who helped.
- [ ] Human timing and slips: reaction delays, pauses, walking when escorting or in crowds, plausible mistakes, never visible loops.
- [ ] Conversation from that memory; compare Jev with local decisions at population scale; enable models live within $5 a month.

Parked: one decision provider interface for any model (Jev, Claude, DeepSeek), chosen in config. Held: seeding a resident with 75,000 gold for a house, guild and player vendor (it would feel like deus ex machina); residents earn it.

Also open: thieves robbing grey and red players (needs the Thieves' Guild: Recall or boats); population tuning from player signals. Planned: Recall, resurrecting pets, other facets, power scrolls, guild sparring. Deferred: murderers, treasure hunts, boats.

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
