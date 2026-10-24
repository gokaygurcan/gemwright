# Death, resurrection, and replacement equipment

[Documentation index](README.md)

The Britain fighter retains a recovery goal independently of the current connection or Jev decision. `fighter-recovery.ts` owns death handling and corpse decisions. `fighter-equipment.ts` obtains essentials. `fighter-town.ts` handles ordinary purchases, sales, banking, and town rest. `fighter-combat.ts` handles healing and short withdrawals; `fighter-encounter.ts` executes one fight. The shared context and counters are in `fighter-context.ts`. Each file stays below the root `AGENTS.md` size limit.

## Durable recovery phases

`checkpoint.hunting.recovery` is optional for existing residents. Its stages are `healer`, `corpse`, `equipment`, and `ready`. It records the observed character name, death time, number of corpse attempts, and latest recovery outcome. The existing `deathSite` and `corpse` fields retain player-observed locations and identity. An encounter also retains its last observed position as a search hint if the death-status location was lost during a disconnect; `locationSource` distinguishes this from a confirmed death-status location. A hint still requires observed corpse ownership before any transfer. No location is obtained through server administration.

On death, the character persists a return intent, clears the interrupted encounter, and records the death location when the client received it. The death-status packet can precede the shard's young-player relocation. A reconnect rebuilds world observations and resumes the saved phase. If a resurrection acknowledgement was lost but the next session observes a living body, the character advances to corpse recovery without requesting another resurrection.

Old checkpoints with a corpse location but no death time receive a conservative expired recovery record. A recovery that cannot proceed retains its phase and a visible stopped outcome rather than silently declaring success. Repeated deaths during recovery are bounded to three attempts per behavior run.

## Ordinary healer resurrection

A ghost travels to the closest healer or ankh (`resurrection.ts`), then finds the actual healer among the townsfolk by its name property (cliloc 1050045 ending "the healer" or "the wandering healer"; guildmasters are not healers). `BaseHealer.OnMovement` offers only when a ghost steps from outside two tiles to within them, so a ghost already close steps out to any reachable tile three to five away, then closes in a tile at a time. A walk that fails along the way does not end the attempt: a ghost cannot open doors (`BaseDoor` checks `CheckAlive`), so one inside a healer's building may have no route out while the healer stands in view.

A ghost cannot double-click either ("I am dead and cannot do that"), so it uses a public moongate by walking onto it (`PublicMoongate.OnMoveOver`) instead of using it (`moongate.ts`). After a resurrection far from home, the way back takes the moongate nearest home before walking, since a healer may be across water (Skara Brae).

Live evidence (2026-10-22, Bram Pike): six recovery attempts failed at Jhelom and through the moongates before these fixes; afterwards the Skara Brae healer raised it on the first approach and it returned to Britain through the moongate.

The runtime accepts recognized free resurrection layouts only. It validates the Resurrection heading, supported explanatory text, Continue label, and offered reply button. Paid or unknown layouts are not accepted. It waits for the living body, refreshes status and backpack contents, and recovers health before approaching a corpse. The shard decides whether the character qualifies for resurrection.

ServUO's corpse-equipment packet (`0x89`, variable length) and waypoint display/removal packets (`0xE5` variable length and `0xE6` five bytes) are framed explicitly. Resurrection sends waypoint removals even to this classic profile. Missing their boundaries previously caused the client to reject the remainder of a successful resurrection update. Packet lengths were checked against the pinned ServUO source; unrelated unknown packet IDs still fail explicitly.

## Recover or replace

`recover-if-safe` permits a corpse attempt only with at least 80% observed health, no nearby observed hostile mobile, fewer than two attempts, and a death no more than fifteen minutes old. This age is an application limit, not a promise about shard corpse decay. Unknown death age is treated conservatively. If a death-status timestamp was not observed, the earlier persisted encounter start time is used; a reconnect does not make an old death fresh.

The character approaches the recorded location from a distance, re-identifies the corpse through its received owner-name property, and checks threats and health throughout the approach and transfers. A retained serial alone never authorizes opening a corpse after reconnecting. Missing ownership, an absent or decayed corpse, blocked movement, nearby threats, or insufficient capacity abandons the attempt and returns to town. A disconnect preserves progress for fresh reconciliation instead of immediately retrying an uncertain transfer.

Confirmed personal corpse contents are transferred using normal lift/drop acknowledgements and current carrying limits. Personal items are not automatically classified as vendor loot. Recorded loot retains its existing sale tracking. Successful recovery clears the corpse location and advances to equipment preparation.

`replace-equipment` skips the corpse attempt. `seek-help` sends an authored request once, then obtains essentials without pretending that help arrived or waiting indefinitely for an unsupported cooperation flow.

## Existing possessions and funds

The character checks its own bank for a usable sword and healing supplies. It records the banker-reported balance (`balance` keyword) instead of carrying gold: on the verified ServUO profile, vendors charge carried gold first and then the bank balance (`BaseVendor.OnBuyItems`). Spending decisions use carried plus recently reported banked gold (`bank-gold.ts`, 15-minute freshness), and a vendor refusal (`500191`/`500192`) is an `insufficient-funds` outcome. `withdrawAccountGold` remains for interactions that genuinely need carried gold.

If no sword is available, the character visits the public blacksmith landmark and buys one supported sword from observed stock, at an offered price no greater than 150 gold and with money left for healing supplies. The purchase and equipment change must be confirmed. Existing gear, starting skills, and funds are never granted or recreated. Missing stock, insufficient funds, a disabled service, or an uncertain transaction stops visibly with the recovery goal intact.

The minimum implemented replacement kit is a supported sword plus at least one usable healing supply. Armor upgrades and replacement of worn-out gear happen on later town trips (`src/fighter-gear.ts`). Once equipped, healed, and free of observed poison, the character reconciles its town trip and resumes ordinary target selection.

## Dressing after revival

Every revival path ends in `prepareEquipment`, which dresses the character before hunting (`fighter-gear.ts`). Recovered corpse contents and wearables from the bank fill empty layers, one item per layer; looted items awaiting sale are never worn. The death robe (`0x204E`, layer 22) is dropped at the character's feet only when recovered torso clothing or armor can replace it, so an abandoned corpse does not leave the character bare. When the corpse was abandoned, the bank visit happens even with a sword in hand, and the character dresses again with what the bank provided before buying anything. Refused items are not retried in the same session. This path still needs live evidence from a real death.

## Healing and poison

Bandages are one option. The fighter also buys healing potions (`0x0F0C`) and cure potions (`0x0F07`) from current vendor stock using its own funds. Desired stock is thirty bandages, four healing potions, and three cure potions, subject to existing price and spending limits.

Poison comes from the current character's received health-bar status packet (`0x17`). The modern movement flag `0x04` means flying in this profile and must not be mistaken for poison. Cure potions take priority while poison is observed; healing potions are not treated as usable healing while poisoned. Using a cure does not assert success: later poison updates determine whether it worked. Item action spacing, retries, and healing cooldowns remain bounded. A dangerous damage burst still causes immediate local retreat.

Related: [Fighter behavior](fighter.md) · [Automatic reconnect](reconnect.md).
