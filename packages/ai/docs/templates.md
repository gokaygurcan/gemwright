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
| `creation.namePrefix` | Operator codename for the template; never used for in-game names. |
| `creation.city` | Requested starting city. |
| `creation.skills` | Requested skill names and starting values in player-visible skill points. |
| `creation.equipment` | Requested starting equipment identifiers; empty in the examples. |
| `creation.provisioning` | `normal-character-creation`: an ordinary login and character-creation screen. |
| `behavior.activities` | Preferred activities. The first matching one picks the behavior: `mine`, `chop`, `hunt`, or a profession (`tamer`, `thief`, `bard`, `fisher`, `tailor`, `crafter`). |
| `behavior.trainingGoals` | Desired future skill levels. |
| `behavior.riskTolerance` | Number from 0 to 1. |
| `behavior.sociability` | Number from 0 to 1. |
| `behavior.cooperation` | Number from 0 to 1. |
| `behavior.supplies` | Desired nonnegative integer quantities by item identifier. |
| `behavior.bankAtWeightRatio` | Preferred carrying-load ceiling, greater than 0 and at most 1; the miner samples smelting and banking thresholds below it. |
| `behavior.corpseRecovery` | `seek-help`, `recover-if-safe`, or `replace-equipment`. |

Population validation remains generic: it rejects structural mistakes without imposing one emulator's skill vocabulary. The ServUO provisioning adapter separately resolves supported skill names (including the `Swordsmanship` alias for `Swords`), allows at most three starting skills totaling 100 points with at most 50 each, requires an offered city, and refuses custom starting equipment.

New residents get a player name that fits their race and sex (`names.ts`, `world/names.json`): humans a given name and a surname, elves an elvish surname, gargoyles a single name in their own style. The pools draw on SphereServer's and ServUO's name lists plus authored ones. A name derives from the resident UUID, so it is stable, never repeats one already on the roster, and stays within ServUO's 16-character limit. It is saved during reconciliation and used at character creation; existing characters are never renamed or recreated. The resident UUID and server serial remain the identity, not the name. Starting stats are the ordinary 40 STR / 30 DEX / 10 INT request, with the server's normal starting kit.

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

In the example, the Minoc miner uses `craftsman@1` and the swordsman `swordsman@1`, requesting Swordsmanship 50 and Tactics 50 through normal creation. Every starting build follows the server's skill-point budget.

### Template revision semantics

An `(id, version)` pair is immutable once stored. Changing its content without increasing the version is an error. Object key order is normalized when comparing snapshots; reformatting JSON does not create a content change. Downgrading below a stored template's latest revision is rejected.

Residents retain both `creationVersion` and `policyVersion`:

- `creationVersion` points to the immutable snapshot from which the resident was instantiated. Updates do not rename, relocate, re-equip, or reset the character.
- `policyVersion` points to the latest accepted behavioral configuration. Reconciliation advances it for existing residents, including parked residents. The executor must apply changed preferences at a safe boundary when it exists.

Changing creation fields in a new revision affects only residents created from that revision. An existing, not-yet-provisioned resident still retains its original creation snapshot. Operators must not expect a version bump to regenerate the roster.

Removing a template from the active configuration parks its residents and preserves its historical snapshots. Reintroducing that template reuses residents in creation order. Residents are never deleted; to stop one for good, list it in `retired.json` ([population](population.md#population-mix)).

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
