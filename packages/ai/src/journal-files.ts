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
export class JournalFiles {
  private traces: { name: string; bytes: number }[] = [];
  private traceBytes = 0;
  private historyBytes = 0;
  private evictedBytes = 0;
  private evictedFiles = 0;
  private diskCheckedAt = 0;
  constructor(
    private readonly directory: string,
    private readonly options = {
      traceBudgetBytes: 512 * 1024 * 1024,
      segmentBytes: 16 * 1024 * 1024,
      reserveBytes: 128 * 1024 * 1024
    }
  ) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).sort()) {
      if (!name.endsWith('.jsonl.gz')) continue;
      const file = await stat(join(this.directory, name));
      if (!file.isFile()) continue;
      if (tracePattern.test(name)) {
        this.traces.push({ name, bytes: file.size });
        this.traceBytes += file.size;
      } else this.historyBytes += file.size;
    }
  }
  statistics() {
    return {
      historyBytes: this.historyBytes,
      traceBytes: this.traceBytes,
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
  private async trim(incoming = 0) {
    const remove: typeof this.traces = [];
    let remaining = this.traceBytes;
    for (const trace of this.traces) {
      if (remaining + incoming <= this.options.traceBudgetBytes) break;
      remove.push(trace);
      remaining -= trace.bytes;
    }
    if (!remove.length) return;
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
    this.historyBytes += await this.append(`${event.at.slice(0, 10)}.jsonl.gz`, [event], 6);
    for (const trace of remove) {
      await unlink(join(this.directory, trace.name));
      this.traceBytes -= trace.bytes;
      this.evictedBytes += trace.bytes;
      this.evictedFiles++;
      this.traces = this.traces.filter((file) => file.name !== trace.name);
    }
  }
  async write(events: TelemetryEvent[]) {
    await this.trim();
    if (Date.now() - this.diskCheckedAt > 5000) {
      const disk = await statfs(this.directory);
      if (Number(disk.bavail) * Number(disk.bsize) < this.options.reserveBytes)
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
        this.historyBytes += await this.append(`${key}.jsonl.gz`, group, 6);
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
      await this.trim();
    }
  }
}
