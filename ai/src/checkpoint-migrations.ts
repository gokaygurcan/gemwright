import type { Checkpoint } from './store';

// Checkpoints are durable resident memory written by many runtime revisions. Each load upgrades
// an older shape in place; a checkpoint from a newer runtime is refused rather than guessed at.
// Component memories (experience, decisions, mount) keep their own schema versions.
export const CHECKPOINT_VERSION = 2;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function migrateCheckpoint(raw: unknown): Checkpoint {
  if (!record(raw)) throw new Error('Checkpoint is not an object');
  const version = raw.schemaVersion ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error('Invalid checkpoint version');
  if (version > CHECKPOINT_VERSION) throw new Error(`Checkpoint version ${version} is newer than this runtime`);
  const checkpoint = raw as unknown as Checkpoint & Record<string, unknown>;
  if (version < 2) {
    // v1 grew optional fields ad hoc; v2 normalizes the shared ones so readers can rely on them.
    checkpoint.memories = Array.isArray(checkpoint.memories) ? checkpoint.memories.slice(-200) : [];
    checkpoint.relationships = record(checkpoint.relationships) ? checkpoint.relationships : {};
    for (const [key, entry] of Object.entries(checkpoint.relationships)) {
      const value = entry as unknown as Record<string, unknown>;
      if (!record(value)) {
        delete checkpoint.relationships[key];
        continue;
      }
      checkpoint.relationships[key] = {
        affinity: typeof value.affinity === 'number' ? Math.max(-1, Math.min(1, value.affinity)) : 0,
        note: typeof value.note === 'string' ? value.note.slice(0, 240) : ''
      };
    }
    if (checkpoint.goal !== null && !record(checkpoint.goal)) checkpoint.goal = null;
    if (checkpoint.landmarks && !Array.isArray(checkpoint.landmarks.forges)) checkpoint.landmarks.forges = [];
    if (checkpoint.hunting && !Array.isArray(checkpoint.hunting.loot)) checkpoint.hunting.loot = [];
    // Expired depletion entries and stale funds carry no information after an upgrade.
    if (checkpoint.landmarks?.depleted)
      checkpoint.landmarks.depleted = checkpoint.landmarks.depleted.filter((entry) => entry.until > Date.now());
  }
  checkpoint.schemaVersion = CHECKPOINT_VERSION;
  return checkpoint;
}
