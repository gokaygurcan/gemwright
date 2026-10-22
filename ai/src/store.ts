import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { ActivityRecorder, activitySchema } from './activity';
import { migrateCheckpoint } from './checkpoint-migrations';
import { allocatePopulation, type CharacterTemplate, type PopulationConfig, validateConfig } from './config';
import type { DecisionMemory } from './decisions';
import type { ExperienceMemory } from './experience';
import type { MountMemory } from './mount-types';
import { playerName } from './names';
import { timed } from './stall-probe';

// One skill as the server reported it: base and modified value, cap, and lock (0 up, 1 down, 2 locked).
export interface SkillReading {
  base: number;
  value: number;
  cap?: number;
  lock?: number;
}

export interface Checkpoint {
  schemaVersion?: number;
  decisions?: DecisionMemory;
  experience?: ExperienceMemory;
  mount?: MountMemory;
  packAnimal?: MountMemory & { load?: number };
  // Last banker-reported balance; vendors on the verified profile can charge it directly.
  funds?: { bank: number; at: number };
  // Ingots last counted in the bank box; guides whether surplus is sold for working funds.
  stock?: { ingots: number; at: number };
  // A dungeon run in progress (dungeon-crawl.ts, any profession): rooms cleared and avoided, exit
  // mode, results, and the party it belongs to.
  dungeon?: {
    name: string;
    until: number;
    startedAt: string;
    visited: string[];
    avoided: string[];
    room?: string;
    exiting: boolean;
    deepest: number;
    kills: number;
    deaths: number;
    party?: { id: string; leader: number; role: 'leader' | 'member'; plannedSize: number; members: string[] };
  };
  // A corpse left in a dungeon after a death nobody could resurrect (dungeon-death.ts).
  dungeonCorpse?: { dungeon: string; x: number; y: number; z: number; diedAt: string; attempts: number };
  // The resident's current life phase and when it ends (life.ts); `city` is a visit's destination.
  life?: { phase: string; until: number; city?: string };
  // Best price a vendor kind has offered per item graphic (a thief's takings, thief-actions.ts).
  prices?: Record<string, { service: string; price: number }>;
  // Exceptional crafted pieces kept from sale and banked (miner-crafting.ts, craft-training.ts).
  keep?: number[];
  // The tamer's kept fighting pet (tamer-pet.ts).
  companion?: { serial: number; name: string; minTame: number };
  // Last NPC training attempt per skill name.
  training?: Record<string, number>;
  goal: { kind: string; phase: string } | null;
  memories: { at: string; text: string }[];
  // Keyed by observed character name; seen/lastSeen are maintained by relationships.ts.
  relationships: Record<string, { affinity: number; note: string; seen?: number; lastSeen?: string; peer?: boolean }>;
  // depleted: mining spots and vein blocks with the time their ore may have respawned.
  landmarks?: { forges: { x: number; y: number; z: number }[]; depleted?: { key: string; until: number }[] };
  hunting?: {
    loot: number[];
    killsSinceBank: number;
    pending: 'hunt' | 'return';
    // Cemetery currently hunted (cemeteries.ts); absent means Britain.
    ground?: string;
    reconsiderAt?: number;
    encounter?: {
      opponent: number;
      startedAt: string;
      position?: { x: number; y: number; z: number };
      body?: number;
      memoryId?: string;
    };
    recovery?: {
      stage: 'healer' | 'corpse' | 'equipment' | 'ready';
      diedAt: string;
      ownerName: string;
      attempts: number;
      outcome?: string;
      locationSource?: 'death-status' | 'last-seen';
    };
    deathSite?: { x: number; y: number; z: number };
    corpse?: { serial: number; x: number; y: number; z: number };
  };
  mining?: {
    smeltsSinceBank: number;
    smeltsBeforeBank: number;
    smeltAtWeightRatio: number;
    bankAtWeightRatio: number;
    pending?: 'smelt' | 'bank';
  };
}

export interface Resident {
  id: string;
  templateId: string;
  creationVersion: number;
  policyVersion: number;
  ordinal: number;
  proposedName: string;
  desiredActive: boolean;
  binding: { accountRef: string; characterSerial: string } | null;
  checkpoint: Checkpoint;
  revision: number;
}

interface ResidentRow {
  id: string;
  template_id: string;
  creation_version: number;
  policy_version: number;
  ordinal: number;
  proposed_name: string;
  desired_active: number;
  binding_json: string | null;
  checkpoint_json: string;
  revision: number;
}

function decode(row: ResidentRow): Resident {
  return {
    id: row.id,
    templateId: row.template_id,
    creationVersion: row.creation_version,
    policyVersion: row.policy_version,
    ordinal: row.ordinal,
    proposedName: row.proposed_name,
    desiredActive: row.desired_active === 1,
    binding: row.binding_json ? JSON.parse(row.binding_json) : null,
    checkpoint: migrateCheckpoint(JSON.parse(row.checkpoint_json)),
    revision: row.revision
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// One resident's dungeon run. Party members share a party id; a party that never assembled is
// recorded by its leader with `assembled` false.
export interface DungeonRunRecord {
  id: string;
  residentId: string;
  name: string;
  partyId: string | null;
  role: 'solo' | 'leader' | 'member';
  dungeon: string;
  plannedSize: number;
  members: { name: string; skills: Record<string, number> }[];
  assembled: boolean;
  startedAt: string;
  endedAt: string;
  outcome: string;
  deepest: number;
  kills: number;
  deaths: number;
}

export class ResidentStore {
  private readonly db: Database;

  constructor(
    path: string,
    readonly shardId: string
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    // The database holds game-account passwords: owner-only, like the credential files it replaces.
    if (path !== ':memory:')
      for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    try {
      this.db.run('PRAGMA busy_timeout = 5000');
      this.db.run('PRAGMA foreign_keys = ON');
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = FULL');
      this.db
        .transaction(() => {
          const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
          if (version === undefined || version < 0 || version > 5)
            throw new Error(`Unsupported resident database version: ${version}`);
          if (version === 0) {
            this.db.exec(`
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE templates (
              id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL,
              PRIMARY KEY (id, version)
            );
            CREATE TABLE residents (
              id TEXT PRIMARY KEY,
              template_id TEXT NOT NULL,
              creation_version INTEGER NOT NULL,
              policy_version INTEGER NOT NULL,
              ordinal INTEGER NOT NULL,
              proposed_name TEXT NOT NULL,
              desired_active INTEGER NOT NULL CHECK (desired_active IN (0, 1)),
              binding_json TEXT,
              checkpoint_json TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 0,
              UNIQUE (template_id, ordinal),
              FOREIGN KEY (template_id, creation_version) REFERENCES templates(id, version),
              FOREIGN KEY (template_id, policy_version) REFERENCES templates(id, version)
            );
            PRAGMA user_version = 1;
          `);
          }
          if (version === 0 || version === 1) {
            this.db.exec(`CREATE TABLE runtime_lease (
              id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
            ); PRAGMA user_version = 2;`);
          }
          // Version 3: game-account credentials and hourly skill snapshots live with the residents,
          // so a population's container keeps everything in this one private file.
          if (version !== undefined && version < 3) {
            this.db.exec(`CREATE TABLE credentials (
              resident_id TEXT PRIMARY KEY,
              username TEXT NOT NULL UNIQUE,
              password TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE skill_snapshots (
              resident_id TEXT PRIMARY KEY,
              recorded_at INTEGER NOT NULL,
              skills_json TEXT NOT NULL
            );
            PRAGMA user_version = 3;`);
          }
          // Version 4: one row per resident per dungeon run, solo or in a party, for the report.
          if (version !== undefined && version < 4) {
            this.db.exec(`CREATE TABLE dungeon_runs (
              id TEXT PRIMARY KEY,
              resident_id TEXT NOT NULL,
              party_id TEXT,
              dungeon TEXT NOT NULL,
              ended_at TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
            PRAGMA user_version = 4;`);
          }
          // Version 5: activity totals and position samples for population reports (activity.ts).
          if (version < 5) this.db.exec(`${activitySchema}\nPRAGMA user_version = 5;`);
          const existing = this.db
            .query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key = ?')
            .get('shardId');
          if (existing && existing.value !== shardId) throw new Error('Resident database belongs to a different shard');
          this.db.query('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('shardId', shardId);
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  credentials(residentId: string): { username: string; password: string } | null {
    return (
      this.db
        .query<{ username: string; password: string }, [string]>(
          'SELECT username, password FROM credentials WHERE resident_id = ?'
        )
        .get(residentId) ?? null
    );
  }

  // Inserts unless the resident already has an account; returns the stored credentials either way.
  storeCredentials(residentId: string, credentials: { username: string; password: string }) {
    this.db
      .query('INSERT OR IGNORE INTO credentials (resident_id, username, password, created_at) VALUES (?, ?, ?, ?)')
      .run(residentId, credentials.username, credentials.password, new Date().toISOString());
    const stored = this.credentials(residentId);
    if (!stored) throw new Error('Resident credentials could not be stored');
    return stored;
  }

  skillSnapshot(residentId: string): { recordedAt: number; skills: Record<string, SkillReading> } | null {
    const row = this.db
      .query<{ recorded_at: number; skills_json: string }, [string]>(
        'SELECT recorded_at, skills_json FROM skill_snapshots WHERE resident_id = ?'
      )
      .get(residentId);
    return row ? { recordedAt: row.recorded_at, skills: JSON.parse(row.skills_json) } : null;
  }

  saveSkillSnapshot(residentId: string, skills: Record<string, SkillReading>, now = Date.now()) {
    this.db
      .query(
        `INSERT INTO skill_snapshots (resident_id, recorded_at, skills_json) VALUES (?, ?, ?)
         ON CONFLICT (resident_id) DO UPDATE SET recorded_at = excluded.recorded_at, skills_json = excluded.skills_json`
      )
      .run(residentId, now, JSON.stringify(skills));
  }

  recordDungeonRun(record: DungeonRunRecord) {
    this.db
      .query(
        'INSERT OR REPLACE INTO dungeon_runs (id, resident_id, party_id, dungeon, ended_at, record_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(record.id, record.residentId, record.partyId, record.dungeon, record.endedAt, JSON.stringify(record));
  }

  dungeonRuns(): DungeonRunRecord[] {
    return this.db
      .query<{ record_json: string }, []>('SELECT record_json FROM dungeon_runs ORDER BY ended_at')
      .all()
      .map((row) => JSON.parse(row.record_json));
  }

  close(): void {
    this.db.close();
  }

  acquireLease(ttlMs = 30000, now = Date.now()): string {
    const token = crypto.randomUUID();
    const result = this.db
      .query(`INSERT INTO runtime_lease (id, token, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE runtime_lease.expires_at <= ?`)
      .run(token, now + ttlMs, now);
    if (result.changes !== 1) throw new Error('Another AI runtime owns this shard; wait for its lease to expire');
    return token;
  }

  renewLease(token: string, ttlMs = 30000, now = Date.now()): void {
    const result = this.db
      .query('UPDATE runtime_lease SET expires_at = ? WHERE id = 1 AND token = ? AND expires_at > ?')
      .run(now + ttlMs, token, now);
    if (result.changes !== 1) throw new Error('AI runtime lease lost or expired');
  }

  releaseLease(token: string): void {
    this.db.query('DELETE FROM runtime_lease WHERE id = 1 AND token = ?').run(token);
  }

  list(): Resident[] {
    return this.db.query<ResidentRow, []>('SELECT * FROM residents ORDER BY template_id, ordinal').all().map(decode);
  }

  activityRecorder() {
    return new ActivityRecorder(this.db, (id) => this.get(id)?.checkpoint);
  }

  get(id: string): Resident | undefined {
    const row = this.db.query<ResidentRow, [string]>('SELECT * FROM residents WHERE id = ?').get(id);
    return row ? decode(row) : undefined;
  }

  bindings(): { id: string; name: string; serial: number }[] {
    return this.db
      .query<{ id: string; proposed_name: string; binding_json: string }, []>(
        'SELECT id, proposed_name, binding_json FROM residents WHERE binding_json IS NOT NULL'
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.proposed_name,
        serial: Number(JSON.parse(row.binding_json).characterSerial)
      }));
  }

  template(id: string, version: number): CharacterTemplate | null {
    const row = this.db
      .query<{ snapshot: string }, [string, number]>('SELECT snapshot FROM templates WHERE id = ? AND version = ?')
      .get(id, version);
    return row ? JSON.parse(row.snapshot) : null;
  }

  reconcile(input: PopulationConfig): { created: number; active: number; parked: number } {
    const config = validateConfig(input);
    if (config.shardId !== this.shardId) throw new Error('Configuration belongs to a different shard');
    const allocation = allocatePopulation(config);
    return this.db
      .transaction(() => {
        for (const template of config.templates) {
          const snapshot = canonical(template);
          const previous = this.db
            .query<{ snapshot: string }, [string, number]>(
              'SELECT snapshot FROM templates WHERE id = ? AND version = ?'
            )
            .get(template.id, template.version);
          if (previous && previous.snapshot !== snapshot)
            throw new Error(`Template ${template.id}@${template.version} changed; increment its version`);
          const latest = this.db
            .query<{ version: number | null }, [string]>('SELECT MAX(version) AS version FROM templates WHERE id = ?')
            .get(template.id)?.version;
          if (latest && template.version < latest)
            throw new Error(`Template ${template.id} cannot downgrade from version ${latest}`);
          this.db
            .query('INSERT OR IGNORE INTO templates (id, version, snapshot) VALUES (?, ?, ?)')
            .run(template.id, template.version, snapshot);
        }

        const desired = new Set<string>();
        const reservedNames = new Set(this.list().map((resident) => resident.proposedName));
        let created = 0;
        for (const template of config.templates) {
          const target = allocation[template.id] ?? 0;
          const existing = this.db
            .query<ResidentRow, [string]>('SELECT * FROM residents WHERE template_id = ? ORDER BY ordinal')
            .all(template.id);
          for (const row of existing) {
            if (row.binding_json || row.proposed_name !== `${template.creation.namePrefix} ${row.ordinal}`) continue;
            const name = playerName(row.id, reservedNames);
            reservedNames.add(name);
            this.db
              .query('UPDATE residents SET proposed_name = ?, revision = revision + 1 WHERE id = ?')
              .run(name, row.id);
          }
          for (const row of existing.slice(0, target)) desired.add(row.id);
          let ordinal = existing.at(-1)?.ordinal ?? 0;
          for (let index = existing.length; index < target; index++) {
            ordinal++;
            const id = crypto.randomUUID();
            const name = playerName(id, reservedNames);
            reservedNames.add(name);
            this.db
              .query(`INSERT INTO residents
            (id, template_id, creation_version, policy_version, ordinal, proposed_name, desired_active, checkpoint_json)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
              .run(
                id,
                template.id,
                template.version,
                template.version,
                ordinal,
                name,
                JSON.stringify({ goal: null, memories: [], relationships: {} })
              );
            desired.add(id);
            created++;
          }
        }

        const versions = new Map(config.templates.map((t) => [t.id, t.version]));
        for (const resident of this.list()) {
          const active = desired.has(resident.id);
          const version = versions.get(resident.templateId) ?? resident.policyVersion;
          if (resident.desiredActive !== active || resident.policyVersion !== version) {
            this.db
              .query(
                'UPDATE residents SET desired_active = ?, policy_version = ?, revision = revision + 1 WHERE id = ?'
              )
              .run(Number(active), version, resident.id);
          }
        }
        const residents = this.list();
        return { created, active: desired.size, parked: residents.length - desired.size };
      })
      .immediate();
  }

  saveProgress(id: string, expectedRevision: number, checkpoint: Checkpoint, binding: Resident['binding']): Resident {
    return timed('save', () => this.writeProgress(id, expectedRevision, checkpoint, binding));
  }

  private writeProgress(
    id: string,
    expectedRevision: number,
    checkpoint: Checkpoint,
    binding: Resident['binding']
  ): Resident {
    // Checkpoints describe intentions and observations; the shard remains authoritative for game state.
    const json = JSON.stringify(checkpoint);
    const bindingJson = binding ? JSON.stringify(binding) : null;
    return this.db
      .transaction(() => {
        const result = this.db
          .query(`UPDATE residents SET checkpoint_json = ?, binding_json = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`)
          .run(json, bindingJson, id, expectedRevision);
        if (result.changes !== 1) throw new Error('Resident missing or revision conflict; reload before saving');
        const row = this.db.query<ResidentRow, [string]>('SELECT * FROM residents WHERE id = ?').get(id);
        if (!row) throw new Error('Resident disappeared during transaction');
        return decode(row);
      })
      .immediate();
  }
}
