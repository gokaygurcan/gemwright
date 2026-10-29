import { Worker } from 'node:worker_threads';

import type { TelemetryEvent } from './telemetry-schema';

// Life-event history is append-only; detailed diagnostic traces have a bounded rolling window.
export async function openLifeJournal(directory: string, onFailure: (error: Error) => void) {
  const worker = new Worker(new URL('./life-journal-worker.ts', import.meta.url), { workerData: { directory } });
  let storage: Record<string, number> = {};
  let pending: TelemetryEvent[] = [];
  let pendingBytes = 0;
  let sequence = 0;
  let committed = 0;
  let inflight = false;
  let sentAt = 0;
  let commitMs = 0;
  let maxCommitMs = 0;
  let inflightBytes = 0;
  let dropped = 0;
  let closed = false;
  let failure: Error | undefined;
  const waiting: { sequence: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  const fail = (error: Error) => {
    if (failure || closed) return;
    failure = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    onFailure(error);
  };
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.on('error', (error) => {
      const e = error instanceof Error ? error : new Error(String(error));
      reject(e);
      fail(e);
    });
    worker.on('exit', (code) => {
      if (!closed) {
        const e = new Error(`Life journal worker exited (${code})`);
        reject(e);
        fail(e);
      }
    });
  }).catch(async (error) => {
    closed = true;
    await worker.terminate();
    throw error;
  });
  const send = () => {
    if (inflight || failure || !pending.length) return;
    const events = pending;
    pending = [];
    inflightBytes = pendingBytes;
    pendingBytes = 0;
    inflight = true;
    sentAt = Date.now();
    worker.postMessage({ events, through: sequence });
  };
  worker.on('message', (message: { through?: number; problem?: string; storage?: Record<string, number> }) => {
    if (message.storage) storage = message.storage;
    if (message.problem) return fail(new Error(message.problem));
    if (message.through === undefined) return;
    committed = message.through;
    commitMs = Date.now() - sentAt;
    maxCommitMs = Math.max(maxCommitMs, commitMs);
    inflightBytes = 0;
    inflight = false;
    for (let i = waiting.length - 1; i >= 0; i--) {
      const waiter = waiting[i];
      if (waiter && waiter.sequence <= committed) {
        waiting.splice(i, 1);
        waiter.resolve();
      }
    }
    if (waiting.length || pendingBytes >= 256 * 1024) send();
  });
  const timer = setInterval(send, 1000);
  timer.unref();
  const flush = () => {
    if (failure) return Promise.reject(failure);
    if (committed >= sequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiting.push({ sequence, resolve, reject });
      send();
    });
  };
  return {
    append(event: TelemetryEvent) {
      if (failure || closed) return;
      const bytes = JSON.stringify(event).length * 2;
      // Telemetry is never worth the town: a slow or full journal writer drops the newest events
      // (and says so in its statistics) instead of stopping the runtime.
      if (pendingBytes + bytes > 8 * 1024 * 1024) {
        dropped++;
        return;
      }
      pending.push(structuredClone(event));
      pendingBytes += bytes;
      sequence++;
      if (pendingBytes >= 256 * 1024) send();
    },
    flush,
    statistics: () => ({
      storage,
      pendingEvents: pending.length,
      pendingBytes,
      dropped,
      inflightBytes,
      inflightMs: inflight ? Date.now() - sentAt : 0,
      submitted: sequence,
      committed,
      commitMs,
      maxCommitMs,
      failure: failure?.message ?? null,
      closed
    }),
    async close() {
      clearInterval(timer);
      try {
        await flush();
      } finally {
        closed = true;
        await worker.terminate();
      }
    }
  };
}
