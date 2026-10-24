# Persistence

[Documentation index](README.md)

## Checkpoint versions

`checkpoint-migrations.ts` upgrades every checkpoint as it is loaded. Version 2 stamps `schemaVersion`, bounds memories, normalizes relationship entries (affinity clamped to −1..1), resets malformed goals, ensures forge and loot arrays, and drops expired depletion entries. A checkpoint from a newer runtime is refused. Component memories (experience, decisions, mount) keep their own versions.

Relationships record encounters with fellow residents (`relationships.ts`): name, encounter count (one per five minutes apart), last place, and `peer: true`, bounded to 50 entries and scanned at most every 30 seconds. Affinity is unchanged until stage-5 cooperation gives it meaning; human players are not yet distinguished from townsfolk NPCs.

## Persistence and recovery

### Authority boundaries

| State | Authority |
| --- | --- |
| Templates and desired population | Versioned operator configuration. |
| Resident identity, preferences, memories, relationships, goals | External resident store. |
| Skills, inventory, equipment, bank, position, health, death, resources | Shard server. |
| Connection state and outstanding protocol interactions | Live session; reconstructed after reconnect. |

The resident store must not restore an inventory, health value, or balance over the server's state. A remembered corpse location or previous activity is context, not current truth.

### Current database

The foundation uses Bun’s built-in SQLite driver with foreign keys, WAL, `synchronous=FULL`, a busy timeout, and synchronous immediate transactions. It adds no dependencies. Database schema version is recorded with `PRAGMA user_version`; current version 2 adds the runtime lease. Existing version-1 databases migrate transactionally without resetting residents. Unsupported versions fail rather than being guessed at or overwritten.

Each database belongs to one `shardId`. Reusing it with another shard is rejected. Keep shard IDs stable; changing one is not a supported migration.

Tables:

- `metadata`: shard ownership.
- `templates`: immutable revision snapshots.
- `residents`: UUID, template references, ordinal, proposed name, desired activation, optional binding, checkpoint, and optimistic revision counter.
- `runtime_lease`: one expiring owner token for the shard database.
- `credentials`: each resident's game account (schema version 3).
- `skill_snapshots`: each resident's skills, saved at most once an hour (schema version 3).

Bindings contain an account reference (`resident:<resident UUID>`) and the server’s actual character serial, not a password. The resident database (schema version 3) stores each resident's unique ordinary account name and random password in its `credentials` table; the database file is owner-only (mode 0600, directory 0700), so a population is self-contained in its own container and volume. Accounts from the earlier `credentials/<resident UUID>.json` files are imported on first use; those files must still be private and not symlinks, and can be deleted once every resident has run. The same file keeps an hourly skill snapshot per resident (`skill_snapshots`, `src/skill-snapshots.ts`), reported by the `skills` command. Credentials are never included in proofs, model state, or CLI output. Missing credentials for an already bound resident require recovery; they are not silently replaced.

The first checkpoint format holds an optional goal (`kind`, `phase`), timestamped memories, and relationships with affinity and notes. It is an internal TypeScript interface, not a validated external import format or complete behavior serialization protocol. Checkpoints deliberately do not include authoritative game state. Expand and version this format before richer persisted behaviors are introduced.

`saveProgress` checks the expected resident revision so a stale writer cannot silently overwrite a newer update. Reconciliation also increments revisions when activation or policy changes. A caller must reload after a revision conflict.

### Crash behavior

A committed transaction survives normal process restarts. An interrupted transaction rolls back. Tests cover a child process killed with an open write transaction and verify that earlier committed resident progress remains unchanged. This test does not simulate storage-device failure or prove all filesystem durability properties.

Local database durability does not make network actions exactly-once. A server may accept a purchase just before the runtime crashes, while the runtime has not yet recorded its outcome. Recovery must observe inventory, funds, and interaction state before deciding whether another attempt is appropriate. Never replay purchases, trades, casts, or item transfers blindly from a checkpoint.

After reconnecting, the runtime:

1. Re-establishes the ordinary session and identifies the bound character.
2. Rebuilds permitted current observations.
3. Checks whether the character is alive, dead, in danger, or mid-interaction.
4. Compares the remembered intention with current conditions.
5. Resumes, replaces, or abandons the goal through normal player actions.

Death recovery must use actual ghost travel and valid resurrection interactions. Failure to find a route means waiting, seeking help, or another legal behavior; it never authorizes a teleport or automatic resurrection.

### Backups and operations

The database (with credentials and skill snapshots) and local result files are under ignored `packages/ai/data/<shardId>/`. Keep that directory on persistent local storage when deploying. A process restart cannot preserve data on a hosting volume that is discarded.

For the current CLI, close all users of the database before copying the data directory for backup. Do not copy only the main SQLite file while WAL writes are active. Add a supported consistent backup procedure before deploying a continuously running runtime. Coordinate restore decisions with the shard's own saves and re-observe server state after any restore.

Related: [reconnect](reconnect.md) · [decisions](decisions.md).
