# Templates and archetypes

[Documentation index](README.md)

## Templates

The canonical starter configuration is `packages/ai/templates/population.example.json`. It contains two templates: a Minoc miner and a Britain swordsman. These are examples, not a claim that every shard accepts those exact creation selections.

A single population configuration contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Configuration format version; currently `1`. |
| `shardId` | Stable lowercase shard identifier. A resident database is bound to this ID. |
| `targetPopulation` | Nonnegative integer desired concurrent population. |
| `templates` | Explicit character definitions with unique IDs. |
| `allocation` | Weighted or fixed allocation of the target across templates. |

Each template contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable identity for the type of resident; changing it creates a different type. |
| `version` | Positive integer revision, increased whenever the template changes. |
| `label` | Operator-facing description. |
| `archetype` | Optional `{ "id": "swordsman", "version": 1 }` reference to a reusable long-term build from `packages/ai/templates/archetypes.json`. Validation resolves it into a full persisted snapshot. |
| `creation.namePrefix` | Template codename for operator discussion; never used to generate new in-game names. Retained for configuration compatibility. |
| `creation.city` | Requested starting city. |
| `creation.skills` | Requested skill names and starting values in player-visible skill points. |
| `creation.equipment` | Requested starting equipment identifiers; empty in the examples. |
| `creation.provisioning` | Currently only `normal-character-creation`. The session command provisions through normal login and the ordinary creation packet when explicitly enabled. |
| `behavior.activities` | Preferred activities. The first matching behavior name picks the runtime: `mine`, `chop`, `hunt`, or a profession (`tamer`, `thief`, `bard`, `fisher`, `tailor`). |
| `behavior.trainingGoals` | Desired future skill levels. |
| `behavior.riskTolerance` | Number from 0 to 1. |
| `behavior.sociability` | Number from 0 to 1. |
| `behavior.cooperation` | Number from 0 to 1. |
| `behavior.supplies` | Desired nonnegative integer quantities by item identifier. |
| `behavior.bankAtWeightRatio` | Preferred carrying-load ceiling, greater than 0 and at most 1; the miner samples smelting and banking thresholds below it. |
| `behavior.corpseRecovery` | `seek-help`, `recover-if-safe`, or `replace-equipment`. |

Population validation remains generic: it rejects structural mistakes without imposing one emulator's skill vocabulary. The ServUO provisioning adapter separately resolves supported skill names (including the `Swordsmanship` alias for `Swords`), allows at most three starting skills totaling 100 points with at most 50 each, requires an offered city, and refuses custom starting equipment. Behavioral activities describe preferences; the current miner is a specific implemented behavior, while general activity selection remains pending. Additional creation builds and custom shard vocabularies need explicit profile support.

New residents receive a player name such as `Rowan Vale`, selected independently of profession from an original given-name and surname pool. The reference project's [NamePool](https://github.com/Klein187/uo-offline/blob/main/playerbots/source/CustomBots/NamePool.cs) inspired the approach; its lists and implementation are not imported. Selection is seeded by resident UUID, avoids case-insensitive collisions with all persisted residents (including parked ones), and is saved in `proposedName` during reconciliation. Provisioning uses that exact saved name and validates the server profile's 2–16-character limit. The initial pool holds 1,024 combinations; exhaustion stops creation with an explicit error. Name uniqueness is local to our roster; unrelated shard players are outside that guarantee. Names survive restarts and policy changes. Template prefixes and ordinals remain operator codenames. Legacy numeric labels are replaced during reconciliation only for residents without a server binding. Existing bound characters are not silently renamed or recreated. The already-created **Miner A** (`0x000036B4`) is intended to become **Rowan Vale** before this implementation stage is finished; the server-side rename is pending. Longer or unsupported names are rejected rather than silently truncated. The current ordinary human creation defaults request strength 40, dexterity 30, intelligence 10, and no extra equipment; the server applies its normal creation rules and starting kit. The resident UUID and actual server serial remain the identity, regardless of display name.

No arbitrary starting items, skills, or location changes will be injected into the world. If a requested template cannot be created through supported ordinary character creation, provisioning must reject it or require an explicit future design decision about shard setup. Never silently substitute a privileged mechanism.

### Reusable character archetypes

`packages/ai/templates/archetypes.json` holds the player builds residents grow into: primary skills, supporting skills in order of preference, and long-term stat targets.

| Archetype | Primary skills | STR | DEX | INT |
| --- | --- | ---: | ---: | ---: |
| `pure-mage` | Magery, Eval Int | 100 | 25 | 100 |
| `tank-mage` | Magery, Tactics | 100 | 45 | 80 |
| `swordsman` | Swordsmanship, Tactics | 100 | 100 | 25 |
| `mace-fighter` | Mace Fighting, Tactics | 100 | 100 | 25 |
| `fencer` | Fencing, Tactics | 100 | 100 | 25 |
| `archer` | Archery, Tactics | 100 | 100 | 25 |
| `bard` | Provocation, Musicianship | 90 | 45 | 90 |
| `tamer` | Animal Taming, Animal Lore | 100 | 25 | 100 |
| `archer-tamer` | Animal Taming, Archery | 90 | 90 | 45 |
| `thief` | Stealing, Snooping | 100 | 80 | 45 |
| `craftsman` | Blacksmithy, Mining | 100 | 25 | 100 |
| `fisherman` | Fishing, Cooking | 100 | 50 | 75 |
| `tailor` | Tailoring, Arms Lore | 100 | 25 | 100 |

Every stat target totals 225: these are builds residents train toward, not starting values or server grants. Stats are locked at the target, raised below it and lowered above it ([skill usage](skill-usage.md)). Primary skills set the build's focus; supporting skills are an ordered pool residents train in idle time, within the shard's skill cap.

A population template can opt into an archetype:

```json
"archetype": { "id": "pure-mage", "version": 1 }
```

The optional reference resolves to its full definition during configuration validation. The resolved primary/supporting lists and stat targets are included in the immutable template snapshot stored in SQLite, so changing files does not rewrite a resident's historical build. Validation is reentrant: an already resolved template can be reconciled again without losing its build information. Unknown references, duplicate archetype versions, unknown skills, skill aliases repeated across primary/supporting groups, and malformed stat targets are rejected. When a build changes, retain its previous catalog entry and add a new version, then increment the referencing population template version. Templates without an archetype remain valid.

`packages/common/src/skills.ts` (`@gemwright/common/skills`) provides one shared protocol skill lookup. It accepts case and spacing variants such as `Eval Int`, `Eval int`, `Magic Resist`, `Animal Taming`, and `Detect Hidden`, plus aliases `Swordsmanship → Swords`, `Mace Fighting → Macing`, `Blacksmithy → Blacksmith`, `Parrying → Parry`, and `Inscription → Inscribe`. These aliases are used by ordinary character provisioning as well as archetype validation. The catalog keeps readable player-facing skill names.

List the complete catalog, including supporting skills, without a shard configuration or connection:

```sh
bun run packages/ai/src/index.ts archetypes
```

The Minoc miner specializes in `craftsman@1`; adding the build does not turn its mining executor into a crafting executor. The swordsman example uses `swordsman@1` and requests its two primary skills, Swordsmanship 50 and Tactics 50, through normal creation. All starting builds still follow the supported profile's skill-point budget, and starting stats remain the existing 40 STR / 30 DEX / 10 INT request. Long-term stat training, skill locks, cap-aware training allocation, and the other combat/support executors remain roadmap work. Adding this catalog does not provision any new account or resident on the live shard.

### Template revision semantics

An `(id, version)` pair is immutable once stored. Changing its content without increasing the version is an error. Object key order is normalized when comparing snapshots; reformatting JSON does not create a content change. Downgrading below a stored template's latest revision is rejected.

Residents retain both `creationVersion` and `policyVersion`:

- `creationVersion` points to the immutable snapshot from which the resident was instantiated. Updates do not rename, relocate, re-equip, or reset the character.
- `policyVersion` points to the latest accepted behavioral configuration. Reconciliation advances it for existing residents, including parked residents. The executor must apply changed preferences at a safe boundary when it exists.

Changing creation fields in a new revision affects only residents created from that revision. An existing, not-yet-provisioned resident still retains its original creation snapshot. Operators must not expect a version bump to regenerate the roster.

Removing a template from the active configuration parks its residents and preserves its historical snapshots. Reintroducing that template reuses residents in creation order. There is no resident deletion or template-history pruning command in this milestone.

## Temperament

Residents of one template are different people. `temperament.ts` derives a stable temperament from each resident id (no random state is stored), and `personalTemplate` shades the shared policy with it before a session starts:

| Trait | Range | Effect |
| --- | --- | --- |
| `riskShift` | −0.15 to +0.15 | Added to risk tolerance (clamped 0–1); affects optional opponent tiers. |
| `bankRatioShift` | −0.08 to +0.05 | Added to the bank-at-weight ratio (clamped 0.5–0.95). |
| `carriedGold` | 800–2,500 | Carried gold that prompts a soft town trip. |
| `fieldHealAt` | 0.75–0.95 | Health ratio below which a fighter bandages between fights. |
| `patrolOffset`, `patrolReverse` | 0–3, either direction | Where and which way a fighter walks around the graveyard. |
| `restlessness` | 0.7–1.3 | Life phases last 1/restlessness as long as configured ([population](population.md#life-phases)). |

The temperament is also part of the decision state, so Jev sees each character's disposition. The configured template is never modified, and template revisions keep each resident's temperament.

## Crafting

Crafting recipes come from `catalogs/crafts/<skill>.json`: every recipe ServUO's craft menu offers that needs only the skill's basic material (alchemy: one reagent and a bottle), with its menu group and label, skill range, material count and what the trade's vendor pays. Gargoyle-only gear and recipes sharing a menu label are left out. Regenerate with `bun run packages/ai/src/build-crafts.ts --servuo <ServUO> --output packages/ai/catalogs/crafts`. Crafters train on the hardest recipe still teaching them that the vendor buys back until their skill goal, then craft only what pays (`chooseRecipe`); exceptional pieces are banked. Alchemists (Moonglow, Britain, Vesper) buy reagents and bottles from the alchemist and sell potions back; bowyers (Yew, Skara Brae, Britain) buy boards from the carpenter and sell bows and crossbows to the bowyer.

## Appearance

New characters are created with a look of their own (`appearance.ts`), derived from the resident id so it never changes: about half are women; the race is picked from `ai.races` in the shard's `gemwright.json` (default human and elf); skin, hair style and colour, beards (some men only; elves and women have none) and the starting shirt and pants colours stay within ServUO's race rules (`RaceDefinitions.cs`, dyeable hues 2–1001). Elves need Mondain's Legacy and gargoyles Stygian Abyss: the CLI rejects a race the expansion lacks, and the runtime creates only the races the expansion has. Gargoyles wear their own gear, so they are created only when listed. Existing characters keep the look they were created with.

## Population allocation

Weighted allocation divides the target in proportion to positive integer weights. It uses largest remainders, with template ID ascending as a stable tie-breaker. Integer arithmetic avoids floating-point rounding errors. Allocation is independent of entry ordering and always sums to the target.

For example, a target of five with miner weight 1 and swordsman weight 1 produces three miners and two swordsmen, because `britain-miner` sorts first for the remaining slot.

Fixed allocation provides exact nonnegative counts per template. Counts must sum to `targetPopulation`; inconsistent settings are rejected. Templates omitted from allocation receive zero active slots in either mode.

On reconciliation:

1. Validate the complete configuration.
2. Begin an immediate database transaction.
3. Verify and store immutable template revisions.
4. Reuse existing residents for each template, oldest ordinal first.
5. Create residents only when the stored roster for a template is smaller than its allocation.
6. Mark the chosen residents as desired active; park all others.
7. Advance policy versions without changing creation snapshots or progress.
8. Commit all changes together.

Repeating reconciliation with identical input creates no residents and makes no resident revision changes. Scaling down preserves identity and progress. Scaling back up reuses the parked roster before creating additional residents. A weight change can redistribute the active subset and grow a different template's roster.

A target of zero parks everyone. Large values are structurally valid; `population.max` in `world/world.json` caps what a runtime brings in ([population](population.md)).

Related: [persistence](persistence.md) · [commands](commands.md).
