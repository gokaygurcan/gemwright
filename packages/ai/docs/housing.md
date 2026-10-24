# Housing, guilds and wars

[Documentation index](README.md)

Residents who can afford it buy a house, found and join guilds, and side with Order or Chaos. Everything goes through the menus, cursors and speech a player uses on the pinned ServUO (EJ expansion). All of it is built and awaits live evidence.

## Housing districts

Residents build only on the lots of the housing districts in `world/world.json` (`housing.districts`, rectangles on Trammel). Districts keep 250 houses from spreading over the map. With no district, nobody buys a house; the districts are still to be chosen.

`src/build-lots.ts` turns the districts into `catalogs/house-lots.json`:

```bash
bun packages/ai/src/build-lots.ts --assets <client files> --regions <ServUO>/Data/Regions.xml
```

Each district is cut into a grid of 9x13-tile lots, one 7x7 classic house each. That is the house plus the yard ServUO requires: no other house within five tiles in front or behind, or one tile at the sides (`HousePlacement.cs`). The two-tile gaps between rows of houses are walkways. A lot is kept when the house fits by the map files alone (`house-fit.ts`):

- The walls rest flat at the house's height (`Map.GetAverageZ`).
- Nothing impassable or solid stands inside.
- No tile is road or furrow.
- The ring of tiles around the walls is passable.
- It lies outside every Trammel region in `Regions.xml` (towns, dungeons, no-housing areas).

The builder reports how many lots fit in each district; about 250 are needed. Items, mobiles and other houses are known only to the server, so a lot can still be refused live; it is then recorded in `bad_lots` and never tried again.

## Saving and buying

The six 7x7 classic houses cost 35,000 to 36,750 gold. A resident without a house starts saving once it has 5,000 gold banked. While saving, it skips luxuries: archers stop buying exceptional bows and gatherers don't replace a lost pack animal.

At 40,377 banked (the dearest house, the 627-gold tool and the `housing.reserve` of 3,000), the resident buys at its next break point:

1. It claims the free lot nearest its home bank (`houses` table, one per resident). A claim left unused for a day lapses.
2. It buys a House Placement Tool from an architect.
3. It walks to the lot and uses the tool: Classic Houses, then its house. Each resident keeps to one of the six it can afford, chosen by name.
4. It targets the house outline on the front steps and accepts the placement warning.
5. ServUO takes the price from the bank. A new house key in the pack confirms the purchase.

A refused lot is given up for another. Missing funds clear the recorded balance. An account that already owns a house ("You already own a house") records it as `elsewhere`; ServUO allows one house per account.

## Living in it

- About once a day (sooner or later by chaos), the owner walks home and opens its door. A friend opening a house door refreshes ServUO's decay timer.
- Its first visit drops a wooden box (14 gold from a provisioner) inside and secures it ("I wish to secure this"). Kept exceptional pieces and magic or artifact items then go into the box instead of the bank, out of the bank box's 125-item limit.
- Three in ten home-town leisure phases are spent at home.
- Nothing is ever deleted: a house outlives its owner's deaths.

## Guilds

ServUO's EJ guild system has no guildstones. Guilds are founded from the paperdoll's Guild button with a name, an abbreviation and the 25,000-gold fee from the bank.

- **Founders** own a house, have their primary skills at 60 on average, have 30,000 gold banked, and are bold or warm. There is about one guild per 20 residents, and the two sides are kept even.
- **Names** come from a fixed list for each side ("Order of the Silver Oak", "Cult of the Raven"); no name contains another.
- **Members.** Each guild takes 15 to 30 members. Its leader invites residents of the guild's side it sees in town, one at a time, through the roster's Invite Player cursor. Every resident answers invitation gumps by itself: yes to a guild of its side when it has none, otherwise no. New members greet the guild in guild chat.
- **Guildmates** first: residents join a guildmate's dungeon party before a stranger's, and buy a guildmate's market lot before a stranger's.

## Order and Chaos

There are no Order or Chaos guild types in EJ, so the sides are two alliances, "The Order" and "The Chaos". Each resident's side follows its temperament: risk tolerance, low cooperation and chaos lean Chaos.

- Each side's oldest guild leads its alliance. In peace, its leader proposes the alliance to the side's other guilds (Request Alliance; the alliance's name is asked by prompt), and their leaders accept on their next turn.
- **Wars** need `"wars": true` under `ai` in `gemwright.json` (off by default). After a peace of 6 to 18 hours (shorter with more chaos), one side's leader declares war on the other for 24 to 72 hours, and the other leader accepts. ServUO ends the war on time. A guild cannot join an alliance at war, so newcomers join between wars.
- **Fighting.** At war, fighters take on enemy guild members (orange) met on the hunting grounds, never in guarded towns. They fight only when healthy, and at most eight war fights run at once across the population. Residents who don't fight already keep away from orange players (`danger.ts`), and death and recovery work as for any other death.

## Records

The resident database holds:

- `houses` and `bad_lots`
- `guilds`, `guild_members`, `guild_wars` and `war_kills`, written only on the server's confirmations

The population report (`report.ts`) shows houses by kind, residents saving and able to buy, guilds with their side, alliance and members, and recent wars with their kills.

Files: `house-fit.ts`, `build-lots.ts`, `house-lots.ts`, `housing.ts`, `house-life.ts`, `guilds.ts`, `guild-store.ts`, `guild-wars.ts`, `gump-flow.ts`.
