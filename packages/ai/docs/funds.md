# Funds, banking, and town trips

[Documentation index](README.md)

Residents spend and save like ordinary players on the verified ServUO classic profile. Rules below cite the pinned ServUO scripts; other profiles must re-verify them before reuse.

## Vendors charge the bank

`BaseVendor.OnBuyItems` takes carried gold first, then the bank balance (`Banker.Withdraw`, or account gold), then physical gold in the bank box. A purchase fails only when none of these cover it; the vendor then says `500191` or `500192`. The animal trainer follows the same rule.

Consequences in the runtime (`bank-gold.ts`, `VENDORS_DRAW_FROM_BANK`):

- Spending power is carried gold plus the last banker-reported balance (`checkpoint.funds`). A balance older than 15 minutes counts as unknown.
- No withdrawal trips are made before purchases. `withdrawAccountGold` remains for interactions that genuinely need carried gold.
- `chargedPurchase` lowers the recorded balance by whatever the vendor charged beyond the observed carried-gold decrease. After a horse purchase the balance is discarded until the next report.
- A vendor refusal is a typed `insufficient-funds` outcome (`blocked.ts`), not a timeout.
- Purchases are confirmed by the expected stack growing, or by a new backpack item together with the vendor's "The total of thy purchase is" receipt. Delivered art can differ from the stock display (a helmet sold as one graphic arrived as `0x140A`).
- Fighters and miners deposit all carried gold: nothing needs carrying, and carried gold is lost on death.

## Bankers answer from across the room

`Banker.HandlesOnSpeech` accepts the `bank`, `balance`, and `withdraw` keywords within 12 tiles, an exception to ordinary vendor interaction. The runtime identifies a banker by its enabled open-bank context entry without walking over, and speaks from up to 11 tiles (one tile of margin). It only approaches when farther away. Any banker in range may answer, so replies are accepted from any banker. The encoded speech keywords are `0x0000` withdraw, `0x0001` balance, `0x0002` bank, and `0x0009` claim (animal trainer).

## When to go to town

A real player does not ride four minutes to bank a few coins. The fighter (`fighter-trip.ts`) heals in the field between fights while supplies last and no threat is observed, and returns only for a need:

| Need | Kind |
| --- | --- |
| Pack weight at the template's bank ratio | hard |
| Fewer than five bandages and no healing potion | hard |
| Health below half after field healing | hard |
| 1,500 or more carried gold | soft |
| Looted wearable with AOS magic properties | soft |

Magic is read from the ordinary property list (`0xD6`): attribute clilocs `1060400–1060444` and `1060450`, `1060482–1060486`, excluding the elemental damage split (`1060403–1060407`) and base resists (`1060445–1060449`) that every item shows. Hard needs always return. With a decision provider, soft needs become a `town-trip` choice whose deterministic baseline is `return-town`; a "keep hunting" answer holds for ten minutes for the same kind of reason.

## Miner income

The miner deposits ingots and gold, counts the iron ingots in its bank box (`checkpoint.stock`), and sells carried iron ingots before banking when the bank already holds at least 300 or known funds are below 1,000 gold. Minoc's blacksmith (`SBBlacksmith`, 3 gold per iron ingot under the vendor economy) is tried first, then the tool shops. Only whole stacks are sold, so each sale is confirmable.

## Crafting surplus iron

Raw iron sells for 3 gold an ingot (an economy item: 75% of the vendor's 5-gold price). Smithed items are not economy items and sell at the fixed `SBBlacksmith` table price, so surplus iron is worth more crafted. `miner-crafting.ts` ranks recipes by expected gold per ingot at the miner's Blacksmith skill, counting `DefBlacksmithy` success chance and the half-ingot loss on failure:

| Item | Ingots | Pays | Gold/ingot at skill 50 |
| --- | --- | --- | --- |
| Wooden kite shield | 8 | 35 | 4.38 |
| Heater shield | 18 | 115 | 4.34 (6.39 once skill reaches 75) |
| Metal shield | 14 | 60 | 4.29 |
| Dagger | 3 | 10 | 3.33 |

When surplus iron would be sold, the miner instead buys tongs if it has no smithing tool (13 gold, bank-charged), walks to a standing spot within two tiles of both an anvil and a forge, and crafts the best recipe through the ordinary Blacksmithy menu. Buttons are found beside their localized labels (group, then item), never by assumed position. It stops on the server's worn-tool, missing anvil/forge, or insufficient-metal replies, then sells the crafted items and any remainder of raw iron to the smith. Crafting also trains Blacksmith, a template goal. Colored ingots are never crafted or sold.

