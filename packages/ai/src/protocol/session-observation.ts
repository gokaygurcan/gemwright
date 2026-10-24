import type { EventEmitter } from 'node:events';

import { timed } from '../stall-probe';
import { contextMenu, queryStatus } from './packets';
import type { PlayerSession } from './session';

const bounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, Infinity];
export class Latency {
  private readonly buckets = new Uint32Array(bounds.length);
  count = 0;
  totalMs = 0;
  maxMs = 0;
  record(ms: number) {
    this.count++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    const index = bounds.findIndex((b) => ms <= b);
    this.buckets[index] = (this.buckets[index] ?? 0) + 1;
  }
  snapshot() {
    const percentile = (p: number) => {
      if (!this.count) return null;
      let seen = 0;
      for (let i = 0; i < bounds.length; i++) {
        seen += this.buckets[i] ?? 0;
        if (seen >= Math.ceil(this.count * p)) return bounds[i] === Infinity ? this.maxMs : bounds[i];
      }
      return this.maxMs;
    };
    return {
      count: this.count,
      meanMs: this.count ? this.totalMs / this.count : 0,
      maxMs: this.maxMs,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99)
    };
  }
}
export class SessionTiming {
  readonly controller = new AbortController();
  readonly movement = new Latency();
  readonly ping = new Latency();
  private moveAt?: number;
  private pingAt?: number;
  // Last 64 packets (direction, opcode, movement sequence, ms since session start): metadata only,
  // dumped when a movement acknowledgement never arrives.
  private readonly history: [string, number, number | undefined, number][] = [];
  private readonly origin = performance.now();
  private note(direction: string, opcode: number, detail?: number) {
    this.history.push([direction, opcode, detail, Math.round(performance.now() - this.origin)]);
    if (this.history.length > 64) this.history.shift();
  }
  recent() {
    return this.history.map(
      ([d, op, detail, at]) => `${at} ${d} ${op.toString(16)}${detail === undefined ? '' : `#${detail}`}`
    );
  }
  sent(opcode: number, detail?: number) {
    this.note('>', opcode, detail);
    if (opcode === 0x02) this.moveAt = performance.now();
    if (opcode === 0x73 && this.pingAt === undefined) this.pingAt = performance.now();
  }
  received(opcode: number, detail?: number) {
    this.note('<', opcode, detail);
    if ((opcode === 0x21 || opcode === 0x22) && this.moveAt !== undefined) {
      this.movement.record(performance.now() - this.moveAt);
      this.moveAt = undefined;
    }
    if (opcode === 0x73 && this.pingAt !== undefined) {
      this.ping.record(performance.now() - this.pingAt);
      this.pingAt = undefined;
    }
  }
  snapshot() {
    return { movement: this.movement.snapshot(), ping: this.ping.snapshot() };
  }
}
export function waitForUpdate(
  events: EventEmitter,
  state: () => { phase: string; failureReason: string | null },
  predicate: () => boolean,
  label: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      events.off('update', update);
    };
    const update = () => {
      const current = state();
      if (current.failureReason) {
        cleanup();
        reject(new Error(current.failureReason));
      } else if (current.phase === 'offline') {
        cleanup();
        reject(new Error('Session closed'));
      } else if (timed(`wait:${label}`, predicate)) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    events.on('update', update);
    update();
  });
}

const pendingStatus = new WeakMap<PlayerSession, Promise<void>>();
export function refreshCharacterStatus(session: PlayerSession, send: (packet: Buffer) => void): Promise<void> {
  const pending = pendingStatus.get(session);
  if (pending) return pending;
  const result = (async () => {
    if (session.world.serial === null) throw new Error('Character serial is unknown');
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = session.world.received.get(0x11) ?? 0;
      send(queryStatus(session.world.serial));
      try {
        await session.waitFor(() => (session.world.received.get(0x11) ?? 0) > before, 'character status', 2500);
        if (!session.world.status) throw new Error('Shard did not provide weight and health status');
        return;
      } catch (error) {
        if (session.phase !== 'ready' || attempt) throw error;
        await Bun.sleep(250);
      }
    }
  })();
  pendingStatus.set(session, result);
  return result.finally(() => pendingStatus.delete(session));
}

export async function requestContext(session: PlayerSession, serial: number, send: (packet: Buffer) => void) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.world.entities.has(serial)) throw new Error('Context target is not observed');
    session.world.contextMenus.delete(serial);
    send(contextMenu(serial));
    try {
      await session.waitFor(() => session.world.contextMenus.has(serial), 'context menu', 2000);
      const entries = session.world.contextMenus.get(serial);
      if (!entries) throw new Error('Context menu disappeared');
      return entries;
    } catch (error) {
      if (session.phase !== 'ready' || attempt) throw error;
      await Bun.sleep(250);
    }
  }
  throw new Error('Context request failed');
}

// Client resync request (0x22): ServUO answers with a full self update (0x20) and resets its
// movement sequence. Returns whether the authoritative position arrived.
export async function resynchronize(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  sequence: number
): Promise<boolean> {
  console.error(`[movement-timeout] #${sequence}: ${session.timing.recent().join(', ')}`);
  const before = session.world.received.get(0x20) ?? 0;
  send(Buffer.from([0x22, 0, 0]));
  return session
    .waitFor(() => (session.world.received.get(0x20) ?? 0) > before, 'position resync', 3000)
    .then(() => true)
    .catch(() => false);
}
