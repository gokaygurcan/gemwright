# Graveyard fighter

[Documentation index](README.md)

Fighters hunt the undead of the Trammel cemeteries. `fighter.ts` owns the trip; the `fighter-*.ts` modules split it into hunting (`fighter-hunt.ts`), opponents (`fighter-prey.ts`), the fight (`fighter-encounter.ts`, `fighter-combat.ts`), gear (`fighter-gear.ts`, `fighter-equipment.ts`), town (`fighter-town.ts`, `fighter-trip.ts`) and recovery (`fighter-recovery.ts`). The same runtime drives every combat archetype: swordsman, fencer, mace fighter, archer, tank mage and pure mage.

```sh
bun run packages/ai/src/index.ts session \
  --config <population.json> --connection <connection.json> \
  --resident <resident-id> --fighter-assets <assets> --duration 900
```

## Hunting grounds

Fighters hunt the cemeteries with undead spawners on the pinned shard (`Spawns/trammel.xml`, `Graveyards#0–#5`; Nujel'm has none).

| Cemetery | Centre | Spawner maximum | Reached by |
| --- | --- | --- | --- |
| Britain | (1369, 1475) | 9: zombies, skeletons, spectres, wraiths | walking |
| Vesper | (2758, 867) | 9: zombies, skeletons, spectres, wraiths | Minoc moongate |
| Yew | (722, 1119) | 10 skeletons | Yew moongate |
| Jhelom | (1285, 3731) | 9, with shades | Jhelom moongate |
| Moonglow | (4545, 1317) | 4 mixed | Moonglow moongate |
| Cove | (2438, 1099) | 12, with liches | Minoc moongate |

Beyond the cemeteries, `catalogs/hunting-grounds.json` (`src/build-grounds.ts`, from `Spawns/trammel.xml` and `Data/Regions.xml`) lists 326 overland spawns of creatures that attack on sight, outside towns and dungeons, such as the orcs, ratmen, harpies and trolls west of Britain (1055, 1442). Each fighter starts at its home ground (weighted `grounds` in `world/world.json`). After 6–9 patrols in a row without a fight (temperament adds up to three) it moves on (`cemeteries.ts` `nextGround`) to a cemetery or spawn whose creatures its skills meet for at least half of what lives there (`readyFor`). Nearer grounds, richer ones (their loot packs' gold) and less crowded ones are preferred. With more skill the plain cemeteries lose their pull, and chaos shuffles the order a little. Routes over 300 tiles go through the nearest public moongate (`moongate.ts`), then on foot; town trips, ghosts heading for a healer and corpse recovery take the gate too.

## Opponents

`fighter-prey.ts` recognises graveyard undead by body and single-click name (several share a body: wraith, spectre and shade use 26; ghoul and bogle use 153). Every other creature that attacks on sight is tiered the same way from its ServUO stats in `catalogs/monsters.json` (`src/build-monsters.ts`: health, damage, combat skills, armor, fight mode and loot gold for the 479 kinds that dungeons, spawners and the monster and animal scripts bring out). A harpy, orc or lizardman is a brute, a troll or ettin a knight. Passive animals are never opponents.

| Tier | Undead | Needs (weapon / tactics / max hits / armor / health / risk tolerance) |
| --- | --- | --- |
| common | zombie, skeleton | nothing |
| brute | ghoul | 45 / 40 / 60 / 0 / 80% / 0.2 |
| caster | spectre, wraith, shade, bogle, skeletal mage, bone mage | 70 / 65 / 85 / 15 / 90% / 0.3, plus Magic Resist 40 and Healing 50 |
| knight | bone knight, skeletal knight, mummy | 80 / 80 / 90 / 20 / 90% / 0.5 |
| lich | lich | 95 / 95 / 110 / 40 / 95% / 0.7, plus Magic Resist 80 and Healing 50 |
| never | lich lord | — |

Spells ignore armor, so casters also need Magic Resist and reliable healing. Optional tiers need ten bandages or two healing potions and no other undead within six tiles; a knight, lich or lich lord within twelve tiles rules out anything next to it. Player bodies, innocents, and opponents another player stands next to are left alone. Shortfalls are logged as the reason a target was skipped, and encounter experience ([experience](experience.md)) adds caution per body and place. With Jev configured, the choice among eligible opponents is a `hunting-opponent` decision ([decisions](decisions.md)).

## The fight

The fighter approaches, then waits for the server's combatant confirmation (`0xAA`): an attack sent before line of sight is silently refused. A lost combatant is reacquired; an unaccepted attack ends in a retreat. Archers stand 6 tiles off and kite when an opponent closes in; casters fight from range with `mage-combat.ts`, which follows ServUO MageAI (cure, heal by need, interrupt an enemy cast, bless, poison, then damage by mana). Fencers coat their blade with poison before each fight (`fighter-poison.ts`). A fight ends after 90 seconds, or 20 seconds without confirmed damage.

`combat-risk.ts` judges danger from the character's own observed health changes (at most 128 recent records), keeping damage and healing apart so healing never hides a burst. It tracks damage over three and eight seconds, the largest and last hit, the damage rate, and projected health over a four-to-eight-second healing horizon.

- **Emergency escape** (local, no model): a hit of 35% of maximum health that a repeat could make lethal, a burst of half the maximum, health at 20% or below, or less than three seconds of projected life.
- **Otherwise** the tactics are `press-attack`, `bandage-break` (step four to eight tiles away, bandage while moving, re-engage the same opponent at 80% health, at most twice per opponent, within 24 seconds) and `flee-town`. With Jev these are a `combat-tactics` decision; a dangerous change cancels a pending request, and the chosen tactic is rechecked before it runs.

Bandaging tracks its own cursor and completion or failure; recovery is judged from actual health, never from a bandage reply alone.

## Parties

Fighters near each other form real ServUO parties of up to four (`hunting-party.ts`). The leader proposes a target and roles in speech and calls the attack; members answer ready, recover first, or sit the fight out (`party-talk.ts`). With Jev, the target, accepting an invitation, and each member's answer are decisions.

## Gear

`fighter-gear.ts` reads each wearable's layer from tiledata and its AOS specs from the property list: weapon damage over swing speed with damage, hit and speed bonuses; armor resists (physical weighted for undead) and the strength requirement. The better of a carried and a worn piece is kept and the other sold. With 750 gold to spare, one affordable piece (at most 150 gold) per town visit fills an empty shield, legs, helm, gloves, neck, chest or arms slot; the shield comes first because Parry only trains with one held, and a carried light source goes into the pack. Casters wear only leather or studded leather and no shield. A strength refusal (500213) is remembered and the piece is sold.

ServUO pub57 has no NPC repair. Weapons and armor below a quarter of their durability (property 1060639) are retired and replaced while 200 gold is available; a worn weapon goes to the pack so the town step buys a new one.

## Loot and town

A corpse is opened only when an observed death connects it to the selected opponent. The fighter takes gold, gems, weapons and armor, and records loot serials apart from its own gear. After a few kills, low health or its weight threshold it returns to town: vendors buy what they offer to buy, the rest and spare gold are banked, and supplies are restocked ([funds](funds.md)). Vendors, stock and prices come only from what the client sees.

## Training

Ordinary hunting trains weapon skill and Tactics best against evenly matched opponents (ServUO `SkillCheck`), and bandaging while hurt trains Healing. NPCs teach up to a third of their own skill, at most 42.0, for one gold per 0.1 point (`training.ts`): the fighter selects "Train <skill>", reads the quoted price (1019077) and pays exactly that, immediately, withdrawing banked gold above a 750-gold reserve (at most 400 per visit). Each goal skill is trained at most once a day. After quiet graveyard sweeps fighters practise Arms Lore ([skill usage](skill-usage.md)).

Related: [death and recovery](death-recovery.md) · [reconnect and interrupted encounters](reconnect.md) · [decisions](decisions.md).
