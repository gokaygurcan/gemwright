# Mount ownership and travel

[Documentation index](README.md)

Mount use is a firm requirement for player-like residents. Residents buy ordinary horses, verifies ownership, rides for travel and combat, and dismounts before the implemented mining actions. Fishing, lumberjacking, and spellcasting will use the same capability when their behaviors are implemented.

## Buying with earned funds

Fighters check for a mount after preparing in town and after completing a return/bank trip. Miners check in their home region and after banking and resupply. The controller first looks for an existing owned horse; riding never requires a new purchase.

Purchase uses an observed trainer with both stable and buy context actions. Public service landmarks guide the search; they do not prove the vendor or its inventory exists. Britain has three stable landmarks from the supplied location catalog. Minoc uses the public Trammel spawn-template stable location, `(2526,375)`, as a search hint. Every interaction still requires a live observed trainer and a reachable, adjacent, unobstructed approach through doors and stairs.

The trainer, like other ServUO vendors, charges carried gold and then the bank balance, so the character carries nothing for the purchase. It asks an observed banker for its current balance when the recorded one is missing or older than 15 minutes, and counts carried plus banked gold. After a purchase request, the recorded balance is discarded until a fresh banker report. It buys only a currently offered ordinary horse, for at most 750 gold, while retaining 250 working gold for a fighter or 150 for a miner. The current ServUO trainer base price is 550 gold; the runtime checks the actual offer. Pack horses and other animals are excluded. A reported free follower slot is required. No money or animal is granted through server internals.

If funds, stock, follower capacity, or access are unavailable, the character continues on foot and records a bounded retry delay. The miner currently earns materials rather than selling them for mount money: banking ingots does not create spendable gold. It buys a mount only if its own gold actually covers the cost and reserve.

## Ownership and purchase reconciliation

`checkpoint.mount` is optional on older residents and initializes at schema version 1. Unknown schema versions fail explicitly. It stores a bounded state (`seeking`, `purchase-pending`, `owned`, `riding`, `missing`, or `lost`), known horse and mount-item serials, last observed location, retry deadline, and an optional pending purchase with vendor, quoted stock, price, time, location, and up to 128 previously observed horse serials.

Before sending the ordinary buy request, the runtime persists the pending purchase. The trainer delivers a new controlled creature beside the buyer rather than a backpack item. Confirmation requires a newly observed horse with owner-only context actions; friend commands such as Follow and Stay alone are insufficient. Guard or Transfer availability establishes ownership without executing either command.

A disconnect or timeout after purchase leaves the request pending. The runtime can reconcile a newly observed owned horse, but never repeats an uncertain purchase merely because no horse is visible. A definitive rejection from the trainer permits a later attempt. Mounting itself requires the server to equip a mount item on layer 25. The controller retains the association with the observed horse used for that action. On reconnect, actual mount equipment confirms riding even though the creature is internalized and no longer appears as a nearby mobile.

An observed horse death or explicit server refusal of ownership permits replacement when affordable. Missing visibility alone does not prove loss. The character retains its identity/search hint and continues on foot without buying a duplicate. A nearby last-observed position can be searched within 64 tiles on the same facet, at healthy status and without observed threats at the destination, with a two-minute retry delay. Known visible horses that have fallen behind are approached before remounting. Automatic searches of dangerous death sites, stable claims, pet resurrection, and feeding are not implemented yet; unresolved missing animals remain visible recovery work rather than fabricated replacements.

## Travel, combat, and gathering

Normal navigation tries to ride an available owned horse before movement and keeps the observed mount state current. Combat and emergency escape retain an already mounted horse. The fighter does not pause an active fight or resurrection to mount. Mounted combat uses the same normal attacks, damage assessment, potions, bandages, and retreat rules as combat on foot. Mounted spellcasting remains subject to the future spellcasting behavior and shard rules.

The verified classic profile uses a conservative mounted running interval of roughly 115–130 ms and mounted walking interval of 220–235 ms, compared with roughly 210–230 ms and 390–430 ms on foot. Server movement acknowledgement remains authoritative. Stamina and weight decisions use current player status and movement rejection; the runtime does not invent a separate hidden horse stamina value. The pinned ServUO weight/stamina rules themselves account for riding.

Before using a mining tool, the miner leaves war mode, double-clicks itself, and waits for the mount equipment to disappear. It then issues the horse's ordinary Follow context command and targets itself. This requests following; continued obedience is established only by observed movement. The gather action has a final mounted-state guard. Navigation to another resource, forge, bank, or shop attempts to remount the owned horse. These transitions use the same shared controller as the fighter.

Mount failures have local backoff. A missing or unavailable animal leaves the character operational on foot. Region restrictions, poison, form restrictions, and other server refusals cannot be bypassed. Stabling/retrieval, care, deliberate dangerous-site recovery, and wider mount types remain later player-capability work.

## Care and recovery

- A short hop of up to twelve tiles is walked; the horse is only mounted for longer travel. This avoids mounting between neighbouring ore spots.
- A poisoned horse refuses riders (`BaseMount`, `1049692` "too ill to ride"). The character walks for a minute while the horse keeps following, then tries again.
- A missing horse that the server still counts as a follower is alive somewhere; the bounded last-seen search applies. When the follower count is zero, the horse was auto-stabled on logout where the region refused auto-claim, released, or killed. At the next town visit the character says `claim` near an animal trainer (`AnimalTrainer.Claim`): `1042559` returns it, `502671` (nothing stabled) marks the horse lost so a replacement may be bought, and `1049612` reports too many followers. Claims are retried at most every ten minutes.

ServUO auto-stables unattended pets on logout and auto-claims them on login where the region allows (`PlayerMobile.AutoStablePets` and `ClaimAutoStabledPets`).

## Implementation and verification

- `mounts.ts`: ownership reconciliation, mount acknowledgements, dismounting, follow targeting, and navigation integration.
- `mount-services.ts`: owned bank funds, reachable trainer discovery, observed horse offers, and persisted purchase intent.
- `mount-care.ts`: ill-mount handling and stable claims for missing horses.
- `mount-types.ts`: checkpoint schema, mount-equipment observation, and affordability policy.
- `protocol/commerce.ts`: ordinary item and animal purchase requests; animals require separate delivery confirmation.
- `protocol/status.ts`: existing player status plus reported follower capacity.
- `bank-gold.ts`: existing bank balance interpretation and ordinary account withdrawals, shared with equipment recovery.

The miner's dismount guard and remount navigation use the same controller. Poisoned mounts and stabling await a combined live test.
