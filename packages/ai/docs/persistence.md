# Persistence

[Documentation index](README.md)

## Checkpoint versions

`checkpoint-migrations.ts` upgrades every checkpoint as it is loaded. Version 2 stamps `schemaVersion`, bounds memories, normalizes relationship entries (affinity clamped to −1..1), resets malformed goals, ensures forge and loot arrays, and drops expired depletion entries. A checkpoint from a newer runtime is refused. Component memories (experience, decisions, mount) keep their own versions.

Relationships record encounters with fellow residents (`relationships.ts`): name, encounter count (one per five minutes apart), last place, and `peer: true`, bounded to 50 entries and scanned at most every 30 seconds. Conversation and observed shared events update affinity. Direct player interactions also retain serial-based personal memories, separate from incidental peer encounters.

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

The foundation uses Bun's built-in SQLite driver with foreign keys, WAL, `synchronous=FULL`, a busy timeout, and synchronous immediate transactions. It adds no dependencies. Database schema version is recorded with `PRAGMA user_version`; current version 2 adds the runtime lease. Existing version-1 databases migrate transactionally without resetting residents. Unsupported versions fail rather than being guessed at or overwritten.

Each database belongs to one `shardId`. Reusing it with another shard is rejected. Keep shard IDs stable; changing one is not a supported migration.

Tables:

- `metadata`: shard ownership.
- `templates`: immutable revision snapshots.
- `residents`: UUID, template references, ordinal, proposed name, desired activation, optional binding, checkpoint, and optimistic revision counter.
- `runtime_lease`: one expiring owner token for the shard database.
- `credentials`: each resident's game account (schema version 3).
- `skill_snapshots`: each resident's skills, saved at most once an hour (schema version 3).

Bindings contain an account reference (`resident:<resident UUID>`) and the server's actual character serial, not a password. The resident database (schema version 3) stores each resident's unique ordinary account name and random password in its `credentials` table; the database file is owner-only (mode 0600, directory 0700), so a population is self-contained in its own container and volume. The same file keeps an hourly skill snapshot per resident (`skill_snapshots`, `src/skill-snapshots.ts`), reported by the `skills` command. Credentials are never included in proofs, model state, or CLI output. Missing credentials for an already bound resident require recovery; they are not silently replaced.

Checkpoints hold a resident's goal, memories, relationships, decisions, plans, its last look at itself (`self`) and its failed errands (`objectives`, each banned for two hours). They are an internal, versioned format (see above), and deliberately hold no authoritative game state.

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

The database (with credentials and skill snapshots) lives in the shard's data directory ([population](population.md#data-directory)), which must be on persistent storage. On a deployed shard, `gemwright pull` takes a consistent snapshot of it alongside the world saves, and `gemwright restore` puts one back. Locally, stop every process using the database before copying it: copying only the main SQLite file while WAL writes are active is not a backup. Restore the database together with the matching world save; residents re-observe the server's state after any restore.

Related: [reconnect](reconnect.md) · [decisions](decisions.md).
