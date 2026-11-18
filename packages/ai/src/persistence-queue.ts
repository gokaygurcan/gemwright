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
}
// Samples, metrics and signals are telemetry: useful, never the resident's state. Under write
// pressure they are shed first, so a burst of ordinary play can never stop the population.
const optionalWrite = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(activity_samples|activity|population_metrics)\b/i;

// Writes in order, each transaction a group.
export class PersistenceQueue {
  private groups: Group[] = [];
  private bytes = 0;
  sequence = 0;
  dropped = 0;
  overflow = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  get softBytes() {
    return Math.floor(this.limit * 0.6);
  }

  push(writes: Write[]) {
    if (!writes.length) return;
    const through = ++this.sequence;
    const bytes = writes.reduce(
      (n, w) =>
        n + w.sql.length * 2 + w.args.reduce<number>((sum, v) => sum + (typeof v === 'string' ? v.length * 2 : 32), 0),
      0
    );
    const optional = writes.every((write) => optionalWrite.test(write.sql));
    if (this.bytes + bytes > this.limit) {
      // No write pressure may stop the runtime (it used to close every session). Shed telemetry
      // first; if the queue is still over, drop incoming samples, and let state through: the writer
      // catches up on the next commit.
      this.shedOptional();
      if (this.bytes + bytes > this.limit) {
        if (optional) {
          this.dropped++;
          return;
        }
        this.overflow++;
      }
    }
    this.groups.push({ writes, through, bytes });
    this.bytes += bytes;
  }

  // Telemetry groups go first, oldest first, so the bound is on pending bytes rather than on the
  // world's progress.
  private shedOptional() {
    const kept: Group[] = [];
    for (const group of this.groups) {
      if (group.writes.every((write) => optionalWrite.test(write.sql))) {
        this.bytes -= group.bytes;
        this.dropped++;
        continue;
      }
      kept.push(group);
    }
    this.groups = kept;
  }

  take() {
    const groups = this.groups;
    this.groups = [];
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
