import { Worker } from 'node:worker_threads';

import type { RouteRequest, RouteResult } from './path-search';
import { timed } from './stall-probe';
import type { TerrainBuffers } from './terrain';

interface Job {
  id: number;
  request: RouteRequest;
  cancellation: Int32Array;
  resolve: (result: RouteResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  started: number;
}
interface Slot {
  worker: Worker;
  job?: Job;
}
export class PathPool {
  private static readonly pools = new Map<string, PathPool>();
  static get(directory: string, facet: number, buffers?: TerrainBuffers) {
    const key = `${directory}:${facet}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new PathPool(directory, facet, 2, buffers);
      this.pools.set(key, pool);
    }
    return pool;
  }
  static closeAll() {
    for (const pool of this.pools.values()) pool.close();
    this.pools.clear();
  }
  static statistics() {
    return [...this.pools.values()].map((p) => ({
      ...p.stats,
      queued: p.queue.length,
      active: p.slots.filter((s) => s.job).length
    }));
  }
  private readonly queue: Job[] = [];
  private readonly slots: Slot[] = [];
  private next = 0;
  private closed = false;
  readonly stats = {
    submitted: 0,
    completed: 0,
    cancelled: 0,
    exhausted: 0,
    maxQueue: 0,
    maxComputeMs: 0,
    maxWaitMs: 0
  };
  constructor(directory: string, facet: number, size = 2, buffers?: TerrainBuffers) {
    for (let index = 0; index < size; index++) {
      const worker = new Worker(new URL('./path-worker.ts', import.meta.url), {
        workerData: { directory, facet, buffers }
      });
      const slot: Slot = { worker };
      this.slots.push(slot);
      worker.on('message', (message: { id: number; result?: RouteResult; error?: string }) =>
        timed('path-result', () => {
          const job = slot.job;
          if (!job || message.id !== job.id) return;
          slot.job = undefined;
          job.cleanup();
          this.stats.completed++;
          if (message.result) {
            this.stats.exhausted += Number(message.result.exhausted);
            this.stats.maxComputeMs = Math.max(this.stats.maxComputeMs, message.result.elapsedMs);
            job.resolve(message.result);
          } else job.reject(new Error(message.error ?? 'Path worker failed'));
          this.dispatch();
        })
      );
      worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => {
        if (!this.closed) this.fail(new Error(`Path worker exited (${code})`));
      });
      worker.unref();
    }
  }
  run(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult> {
    if (this.closed) return Promise.reject(new Error('Pathfinding pool is closed'));
    if (signal?.aborted) return Promise.reject(new Error('Pathfinding cancelled'));
    if (this.queue.length >= 512) return Promise.reject(new Error('Pathfinding queue is full'));
    return new Promise((resolve, reject) => {
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      const abort = () => {
        Atomics.store(cancellation, 0, 1);
        this.stats.cancelled++;
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        job.cleanup();
        reject(new Error('Pathfinding cancelled'));
      };
      const job: Job = {
        id: ++this.next,
        request,
        cancellation,
        resolve,
        reject,
        started: performance.now(),
        cleanup: () => signal?.removeEventListener('abort', abort)
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.stats.submitted++;
      this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length);
      this.dispatch();
    });
  }
  private dispatch() {
    for (const slot of this.slots) {
      if (slot.job) continue;
      const job = this.queue.shift();
      if (!job) {
        slot.worker.unref();
        continue;
      }
      slot.job = job;
      slot.worker.ref();
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, performance.now() - job.started);
      slot.worker.postMessage({ id: job.id, request: job.request, cancellation: job.cancellation.buffer });
    }
  }
  private fail(error: Error) {
    for (const job of [...this.queue, ...this.slots.flatMap((s) => (s.job ? [s.job] : []))]) {
      job.cleanup();
      job.reject(error);
    }
    this.close();
  }
  close() {
    this.closed = true;
    for (const job of [...this.queue, ...this.slots.flatMap((s) => (s.job ? [s.job] : []))]) {
      Atomics.store(job.cancellation, 0, 1);
      job.cleanup();
      job.reject(new Error('Pathfinding pool closed'));
    }
    this.queue.length = 0;
    for (const slot of this.slots) {
      slot.job = undefined;
      void slot.worker.terminate();
    }
  }
}
