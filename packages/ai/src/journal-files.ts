import { mkdir, open, readdir, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { makeEvent } from './telemetry';
import type { TelemetryEvent } from './telemetry-schema';

const compress = promisify(gzip);
const traceTypes = new Set([
  'perception_snapshot',
  'perception_delta',
  'action_lifecycle',
  'activity',
  'operational_log',
  'runtime_metrics',
  'runtime_health',
  'resident_health'
]);
const tracePattern = /^\d{4}-\d{2}-\d{2}\.trace\.\d{8}\.jsonl\.gz$/;
const dayPattern = /^(\d{4}-\d{2}-\d{2})(?:\.\d{8})?\.jsonl\.gz$/;
interface JournalOptions {
  traceBudgetBytes: number;
  segmentBytes: number;
  reserveBytes: number;
  historyBudgetBytes: number;
  historySegmentBytes: number;
  historyMaxDays: number;
}

// The journal is append-only history for replay, but it shares the volume with the resident
// database: unbounded daily files filled the disk (1.86 GB in a day, 1.9 GB free left overhead).
// History is written in bounded segments and the oldest files are evicted by age and by budget, the
// same way diagnostic traces already were; a full disk evicts before it refuses to write.
export class JournalFiles {
  private traces: { name: string; bytes: number }[] = [];
  private history: { name: string; bytes: number }[] = [];
  private traceBytes = 0;
  private historyBytes = 0;
  private evictedBytes = 0;
  private evictedFiles = 0;
  private diskCheckedAt = 0;
  private readonly options: JournalOptions;
  constructor(
    private readonly directory: string,
    options: Partial<JournalOptions> = {}
  ) {
    this.options = {
      traceBudgetBytes: 512 * 1024 * 1024,
      segmentBytes: 16 * 1024 * 1024,
      reserveBytes: 128 * 1024 * 1024,
      historyBudgetBytes: 1024 * 1024 * 1024,
      historySegmentBytes: 64 * 1024 * 1024,
      historyMaxDays: 2,
      ...options
    };
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).sort()) {
      if (!name.endsWith('.jsonl.gz')) continue;
      const file = await stat(join(this.directory, name));
      if (!file.isFile()) continue;
      if (tracePattern.test(name)) {
        this.traces.push({ name, bytes: file.size });
        this.traceBytes += file.size;
      } else if (dayPattern.test(name)) {
        this.history.push({ name, bytes: file.size });
        this.historyBytes += file.size;
      }
    }
  }
  statistics() {
    return {
      historyBytes: this.historyBytes,
      traceBytes: this.traceBytes,
      historyBudgetBytes: this.options.historyBudgetBytes,
      traceBudgetBytes: this.options.traceBudgetBytes,
      evictedBytes: this.evictedBytes,
      evictedFiles: this.evictedFiles
    };
  }
  private async append(name: string, events: TelemetryEvent[], level: number) {
    const bytes = await compress(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { level });
    const file = await open(join(this.directory, name), 'a', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    return bytes.length;
  }
  private async evict(name: string) {
    const entry = this.history.find((file) => file.name === name);
    if (!entry) return 0;
    await unlink(join(this.directory, name));
    this.history = this.history.filter((file) => file.name !== name);
    this.historyBytes -= entry.bytes;
    this.evictedBytes += entry.bytes;
    this.evictedFiles++;
    return entry.bytes;
  }
  // Oldest first, never the newest file (whose name is passed in), by day age and by total budget.
  private async trim(incoming = 0, keep?: string) {
    const removable = () => this.history.filter((file) => file.name !== keep);
    const today = new Date().toISOString().slice(0, 10);
    const oldestDay = new Date(Date.now() - this.options.historyMaxDays * 86_400_000).toISOString().slice(0, 10);
    for (const file of removable()) {
      const day = dayPattern.exec(file.name)?.[1] ?? today;
      if (day < oldestDay) await this.evict(file.name);
    }
    while (this.historyBytes + incoming > this.options.historyBudgetBytes) {
      const oldest = removable().sort((a, b) => a.name.localeCompare(b.name))[0];
      if (!oldest) break;
      await this.evict(oldest.name);
    }
    const remove: typeof this.traces = [];
    let remaining = this.traceBytes;
    for (const trace of this.traces) {
      if (remaining + incoming <= this.options.traceBudgetBytes) break;
      remove.push(trace);
      remaining -= trace.bytes;
    }
    if (!remove.length) return;
    // The replay knows its trace window is incomplete from this event (replayComplete: false).
    const event = makeEvent(
      'journal',
      'journal_retention',
      'observed',
      {
        reason: 'Bounded diagnostic trace window; life-event history is retained',
        files: remove.map((file) => file.name),
        bytes: remove.reduce((sum, file) => sum + file.bytes, 0),
        replayComplete: false
      },
      { level: 'warn' }
    );
    const segment = this.segment(event.at.slice(0, 10));
    const written = await this.append(segment.name, [event], 6);
    segment.bytes += written;
    this.historyBytes += written;
    for (const trace of remove) {
      await unlink(join(this.directory, trace.name));
      this.traceBytes -= trace.bytes;
      this.evictedBytes += trace.bytes;
      this.evictedFiles++;
      this.traces = this.traces.filter((file) => file.name !== trace.name);
    }
  }
  // A bounded segment of a day: the newest file for that day until it reaches the segment size.
  private segment(day: string) {
    const files = this.history
      .filter((file) => dayPattern.exec(file.name)?.[1] === day)
      .sort((a, b) => a.name.localeCompare(b.name));
    const latest = files.at(-1);
    if (latest && latest.bytes < this.options.historySegmentBytes && latest.name !== `${day}.jsonl.gz`) return latest;
    const index = files.filter((file) => /\.\d{8}\.jsonl\.gz$/.test(file.name)).length;
    const fresh = { name: `${day}.${String(index).padStart(8, '0')}.jsonl.gz`, bytes: 0 };
    this.history.push(fresh);
    this.history.sort((a, b) => a.name.localeCompare(b.name));
    return fresh;
  }
  async write(events: TelemetryEvent[]) {
    await this.trim();
    if (Date.now() - this.diskCheckedAt > 5000) {
      const disk = await statfs(this.directory);
      const free = Number(disk.bavail) * Number(disk.bsize);
      if (free < this.options.reserveBytes)
        throw new Error('Journal disk reserve reached; archive life-event history before continuing');
      this.diskCheckedAt = Date.now();
    }
    const groups = new Map<string, TelemetryEvent[]>();
    for (const event of events) {
      const day = event.at.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid life-event timestamp');
      const trace = traceTypes.has(event.type) && event.level !== 'error' && event.level !== 'warn';
      const key = day + (trace ? '.trace' : '');
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      if (!key.endsWith('.trace')) {
        const day = key;
        const segment = this.segment(day);
        const bytes = await this.append(segment.name, group, 6);
        segment.bytes += bytes;
        this.historyBytes += bytes;
        await this.trim(0, segment.name);
        continue;
      }
      const latest = this.traces.filter((file) => file.name.startsWith(`${key}.`)).at(-1);
      const index = latest
        ? Number(latest.name.split('.')[2]) + (latest.bytes >= this.options.segmentBytes ? 1 : 0)
        : 0;
      const name = `${key}.${String(index).padStart(8, '0')}.jsonl.gz`;
      const bytes = await this.append(name, group, 3);
      const file = this.traces.find((file) => file.name === name);
      if (file) file.bytes += bytes;
      else {
        this.traces.push({ name, bytes });
        this.traces.sort((a, b) => a.name.localeCompare(b.name));
      }
      this.traceBytes += bytes;
      await this.trim(0, name);
    }
  }
}
