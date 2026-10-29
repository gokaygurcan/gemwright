import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

import type { TelemetryEvent } from './telemetry-schema';

export interface ReplayOptions {
  residentId?: string;
  sessionId?: string;
  traceId?: string;
  after?: string;
  before?: string;
  limit?: number;
}
export class EventReplay {
  readonly timeline: TelemetryEvent[] = [];
  readonly sessions = new Map<
    string,
    {
      complete: boolean;
      revision: number;
      self: Record<string, unknown>;
      entities: Map<number, unknown>;
      skills: Map<number, unknown>;
    }
  >();
  readonly counts: Record<string, number> = {};
  readonly issues = {
    malformed: 0,
    legacy: 0,
    duplicate: 0,
    gaps: 0,
    outOfOrder: 0,
    omitted: 0,
    incompleteInput: 0,
    retention: 0
  };
  private readonly sequences = new Map<string, number>();
  private readonly ids = new Set<string>();
  matched = 0;
  constructor(private readonly options: ReplayOptions = {}) {}
  accept(value: unknown) {
    if (!value || typeof value !== 'object') {
      this.issues.malformed++;
      return;
    }
    const event = value as TelemetryEvent;
    if (event.schemaVersion !== 2) {
      this.issues.legacy++;
      return;
    }
    if (
      typeof event.id !== 'string' ||
      typeof event.runId !== 'string' ||
      !Number.isSafeInteger(event.sequence) ||
      typeof event.type !== 'string' ||
      typeof event.result !== 'string' ||
      !Number.isFinite(Date.parse(event.at)) ||
      !event.details ||
      typeof event.details !== 'object'
    ) {
      this.issues.malformed++;
      return;
    }
    if (this.ids.has(event.id)) {
      this.issues.duplicate++;
      return;
    }
    this.ids.add(event.id);
    if (this.ids.size > 8192) this.ids.delete(this.ids.values().next().value ?? '');
    const previous = this.sequences.get(event.runId);
    if (previous !== undefined) {
      if (event.sequence <= previous) this.issues.outOfOrder++;
      else if (event.sequence > previous + 1) this.issues.gaps += event.sequence - previous - 1;
    }
    this.sequences.set(event.runId, Math.max(previous ?? 0, event.sequence));
    if (this.sequences.size > 128) this.sequences.delete(this.sequences.keys().next().value ?? '');
    const filter = this.options;
    if (
      (filter.residentId && filter.residentId !== event.residentId) ||
      (filter.sessionId && filter.sessionId !== event.sessionId) ||
      (filter.traceId && ![event.traceId, event.intentId, event.decisionId, event.actionId].includes(filter.traceId)) ||
      (filter.after && event.at < filter.after) ||
      (filter.before && event.at > filter.before)
    )
      return;
    if (event.type === 'journal_retention' && event.details.replayComplete === false) this.issues.retention++;
    this.matched++;
    const countKey = `${event.type}.${event.result}`;
    const key = countKey in this.counts || Object.keys(this.counts).length < 512 ? countKey : 'other';
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    this.timeline.push(event);
    if (this.timeline.length > Math.max(1, Math.min(10000, filter.limit ?? 1000))) {
      this.timeline.shift();
      this.issues.omitted++;
    }
    if (!event.sessionId || !['perception_snapshot', 'perception_delta'].includes(event.type)) return;
    const state = this.sessions.get(event.sessionId) ?? {
      complete: false,
      revision: 0,
      self: {},
      entities: new Map<number, unknown>(),
      skills: new Map<number, unknown>()
    };
    if (event.type === 'perception_snapshot') {
      state.entities.clear();
      state.skills.clear();
      state.self = {};
      state.complete = event.details.replayComplete === true;
    }
    const revision = Number(event.details.revision);
    if (revision < state.revision || event.details.replayComplete === false) state.complete = false;
    state.revision = revision;
    if (event.details.self && typeof event.details.self === 'object') Object.assign(state.self, event.details.self);
    for (const entity of Array.isArray(event.details.entities) ? event.details.entities : []) {
      if (typeof entity?.serial === 'number') state.entities.set(entity.serial, entity);
    }
    for (const serial of Array.isArray(event.details.removed) ? event.details.removed : [])
      state.entities.delete(serial);
    for (const skill of Array.isArray(event.details.skills) ? event.details.skills : []) {
      if (typeof skill?.id === 'number') state.skills.set(skill.id, skill);
    }
    if (state.entities.size > 8192) {
      state.complete = false;
      while (state.entities.size > 8192) state.entities.delete(state.entities.keys().next().value ?? 0);
    }
    this.sessions.set(event.sessionId, state);
    if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value ?? '');
  }
  summary() {
    const incomplete = Object.entries(this.issues).some(([key, count]) => key !== 'omitted' && count > 0);
    return {
      matched: this.matched,
      counts: this.counts,
      issues: this.issues,
      replayComplete: !incomplete && [...this.sessions.values()].every((state) => state.complete),
      sessions: [...this.sessions].map(([sessionId, state]) => ({
        sessionId,
        ...state,
        complete: state.complete && !incomplete,
        entities: [...state.entities.values()],
        skills: [...state.skills.values()]
      })),
      timeline: this.timeline,
      scope:
        'Recorded observations and causal timeline only; no commands are executed. Gaps and legacy records prevent a complete replay.'
    };
  }
}

export async function replayFiles(paths: string[], options: ReplayOptions = {}) {
  const replay = new EventReplay(options);
  for (const path of paths) {
    const file = createReadStream(path);
    const stream = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
    // Forward filesystem failures to the iterator, including gzip sources.
    file.on('error', (error) => stream.destroy(error));
    stream.setEncoding('utf8');
    let tail = '';
    try {
      for await (const chunk of stream) {
        tail += String(chunk);
        let boundary = tail.indexOf('\n');
        while (boundary >= 0) {
          const line = tail.slice(0, boundary);
          tail = tail.slice(boundary + 1);
          boundary = tail.indexOf('\n');
          if (!line.trim()) continue;
          try {
            replay.accept(JSON.parse(line));
          } catch {
            replay.issues.malformed++;
          }
        }
        if (tail.length > 8 * 1024 * 1024) throw new Error('Replay record exceeds 8 MiB');
      }
      if (tail.trim()) replay.issues.incompleteInput++;
    } catch {
      replay.issues.incompleteInput++;
    } finally {
      stream.destroy();
      file.destroy();
    }
  }
  return replay.summary();
}
