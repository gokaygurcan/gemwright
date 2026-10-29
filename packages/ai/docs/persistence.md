# Persistence

[Documentation index](README.md)

## Authority and recovery

The shard owns skills, inventory, bank, position, health and death. The resident store owns identity, preferences, memories and intentions. Session observations are rebuilt after reconnect. Remembered state never restores possessions or replays purchases, trades, casts or transfers blindly.

Reconnect verifies the bound character, observes its current state, handles danger/death, then resumes or replaces the intention. Resurrection requires ordinary ghost travel and valid interactions.

## Database

The runtime uses a memory mirror and a dedicated SQLite writer. Repeated checkpoints coalesce in bounded five-second batches; disk commits never run on the gameplay thread. Credentials, character bindings, animal purchase intentions and model-spend reservations require durable acknowledgement before the external action. Shutdown drains pending writes. An abrupt crash can lose an unacknowledged checkpoint batch; reconnect re-observes the shard.

`residents.sqlite` retains foreign keys, WAL, `synchronous=FULL`, optimistic revisions and atomic transactions. Schema version 5 includes:

| Tables | Purpose |
| --- | --- |
| `metadata`, `templates` | Shard ownership and immutable template revisions. |
| `residents` | UUID, activation, character binding, checkpoint and optimistic revision. |
| `runtime_lease` | One expiring runtime owner per shard. |
| `credentials` | Unique game account and password per resident. |
| `skill_snapshots`, `dungeon_runs` | Hourly skills and dungeon history. |
| `activity`, `activity_samples` | Work totals and sampled activity. |

Supported migrations run transactionally. Newer unsupported schemas and shard-ID mismatches fail. Keep shard IDs stable. `saveProgress` rejects stale revisions; callers reload after conflicts.

The database contains credentials: mode 0600, parent directory 0700. Credentials never enter proofs, model state or CLI output. Missing credentials for an already bound resident require recovery, not replacement.

## Checkpoints

`checkpoint-migrations.ts` upgrades checkpoints on load; current schema version is 2. It bounds and normalizes memories and relationships, cleans expired entries and refuses newer schemas. Component memories may have their own versions.

`workGoal` stores one active objective, a temporarily suspended objective during recovery, bounded failure cooldowns and the last outcome. Live observations revalidate it; session-only production counters are rebased after reconnect. Inventory changes and movement alone do not prove success.

`landmarks.smithies` remembers observed anvil/forge pairs and standing tiles, rechecked on return. `landmarks.forges` holds smelting destinations. `bulkOrders` stores offer/retry timing and blocker reasons; deed properties remain authoritative for quantities. New iron can reopen a material-blocked order.

Service and life events use schema v2 in `life-events/YYYY-MM-DD.jsonl.gz`, an append-only compressed journal written by a worker. Batches are fsynced before acknowledgement; graceful shutdown drains the queue, while a crash can lose the unacknowledged tail. Life-event history is retained. Diagnostic-only records use `YYYY-MM-DD.trace.NNNNNNNN.jsonl.gz` segments within a 512 MiB rolling budget; evictions are recorded in history. Errors and warnings remain in history. A 128 MiB disk reserve protects database writes; life history still needs archival as it grows. Legacy records and missing sequences prevent complete replay.

```sh
bun packages/ai/src/replay.ts <journal.jsonl.gz>... --resident <UUID>
```

Optional filters: `--session`, `--trace`, `--after`, `--before`, `--limit`. Replay reads recorded observations and causality without sending commands. Thirty-second health records expose lag, latency, queues, acknowledgements, memory and disk.

## Backups

Use persistent storage for the [data directory](population.md#data-directory). `gemwright pull` snapshots the deployed database with world saves; restore matching database and world state together. For manual local copies, stop every database writer first: copying only the main SQLite file during WAL activity is unsafe.

Committed transactions survive normal restarts; interrupted transactions roll back. Tests kill a writer during an open transaction. This does not prove storage-device durability or exactly-once network actions.
