import type { SQLQueryBindings } from 'bun:sqlite';

export interface Write {
  sql: string;
  args: SQLQueryBindings[];
  exec?: boolean;
  changes?: number;
}
interface Group {
  writes: Write[];
  through: number;
  bytes: number;
  resident?: string;
  revision?: number;
}
const checkpointUpdate =
  'UPDATE residents SET checkpoint_json = ?, binding_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?';

// Coalesce only checkpoint-only transactions. Other writes preserve ordering and form a barrier.
export class PersistenceQueue {
  private groups: Group[] = [];
  private checkpoints = new Map<string, Group>();
  private bytes = 0;
  sequence = 0;
  coalesced = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}

  push(writes: Write[]) {
    if (!writes.length) return;
    const through = ++this.sequence;
    const bytes = writes.reduce(
      (n, w) =>
        n + w.sql.length * 2 + w.args.reduce<number>((sum, v) => sum + (typeof v === 'string' ? v.length * 2 : 32), 0),
      0
    );
    const first = writes[0];
    const isCheckpoint = writes.length === 1 && first?.sql.replace(/\s+/g, ' ').trim() === checkpointUpdate;
    const id = isCheckpoint ? String(first.args[2]) : undefined;
    const previous = id ? this.checkpoints.get(id) : undefined;
    if (this.bytes + bytes - (previous?.bytes ?? 0) > this.limit) throw new Error('Persistence queue is full');
    if (previous && first) {
      previous.writes = [
        {
          sql: 'UPDATE residents SET checkpoint_json = ?, binding_json = ?, revision = ? WHERE id = ? AND revision = ?',
          args: [
            first.args[0] ?? null,
            first.args[1] ?? null,
            Number(first.args[3]) + 1,
            id ?? '',
            previous.revision ?? 0
          ],
          changes: 1
        }
      ];
      this.bytes += bytes - previous.bytes;
      previous.bytes = bytes;
      previous.through = through;
      this.coalesced++;
    } else {
      const group: Group = { writes, through, bytes, resident: id, revision: Number(first?.args[3]) };
      this.groups.push(group);
      this.bytes += bytes;
      if (id) this.checkpoints.set(id, group);
      else this.checkpoints.clear();
    }
  }

  take() {
    const groups = this.groups;
    this.groups = [];
    this.checkpoints.clear();
    this.bytes = 0;
    return {
      writes: groups.flatMap((group) => group.writes),
      through: groups.reduce((n, group) => Math.max(n, group.through), 0)
    };
  }
  get pendingBytes() {
    return this.bytes;
  }
}
