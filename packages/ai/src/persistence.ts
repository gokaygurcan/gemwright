import { type Changes, Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { Worker } from 'node:worker_threads';

import { PersistenceQueue, type Write } from './persistence-queue';

// Gameplay reads/writes a memory mirror. Only this worker opens the persistent database.
// Critical actions explicitly await flush(); ordinary checkpoints share a bounded five-second batch.
export async function openPersistence(path: string, shardId: string, onFailure: (error: Error) => void) {
  const worker = new Worker(new URL('./persistence-worker.ts', import.meta.url), { workerData: { path, shardId } });
  const queue = new PersistenceQueue();
  let committed = 0;
  let commits = 0;
  let inflight = false;
  let sentAt = 0;
  let inflightBytes = 0;
  let commitMs = 0;
  let maxCommitMs = 0;
  let failure: Error | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let transaction: Write[] | undefined;
  let finishClose: (() => void) | undefined;
  const waiting: { through: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  const fail = (error: Error) => {
    if (failure || closed) return;
    failure = error;
    clearInterval(timer);
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    onFailure(error);
  };
  const send = () => {
    if (inflight || failure || !queue.pendingBytes) return;
    inflight = true;
    inflightBytes = queue.pendingBytes;
    sentAt = Date.now();
    worker.postMessage(queue.take());
  };
  const snapshot = await new Promise<Uint8Array>((resolve, reject) => {
    worker.once('message', (message: { snapshot?: Uint8Array; problem?: string }) => {
      if (message.snapshot) resolve(message.snapshot);
      else reject(new Error(message.problem ?? 'Missing database snapshot'));
    });
    worker.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(failure);
      fail(failure);
    });
    worker.on('exit', (code) => {
      if (!closed) {
        const error = new Error(`Persistence worker exited (${code})`);
        reject(error);
        fail(error);
      }
    });
  }).catch(async (error) => {
    closed = true;
    await worker.terminate();
    throw error;
  });
  const memory = Database.deserialize(snapshot, { readonly: false, strict: true });
  worker.on('message', (message: { through?: number; problem?: string; closed?: boolean }) => {
    if (message.closed) finishClose?.();
    if (message.problem) return fail(new Error(message.problem));
    if (message.through === undefined) return;
    committed = message.through;
    commits++;
    commitMs = Date.now() - sentAt;
    maxCommitMs = Math.max(maxCommitMs, commitMs);
    inflightBytes = 0;
    inflight = false;
    for (let i = waiting.length - 1; i >= 0; i--) {
      const waiter = waiting[i];
      if (waiter && waiter.through <= committed) {
        waiting.splice(i, 1);
        waiter.resolve();
      }
    }
    if (waiting.length) send();
  });
  const enqueue = (writes: Write[]) => {
    if (failure || closed) return;
    // A full queue is pressure, not a failure: the queue sheds telemetry and lets state through,
    // and a commit is started at once when it is filling, so the population keeps playing.
    queue.push(writes);
    if (queue.pendingBytes > queue.softBytes) send();
  };
  const record = (write: Write) => {
    if (/^\s*PRAGMA\b/i.test(write.sql)) return;
    if (transaction) transaction.push(write);
    else enqueue([write]);
  };
  const check = () => {
    if (failure) throw failure;
    if (closed) throw new Error('Persistence is closed');
  };
  const database = new Proxy(memory, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== 'function') return method;
      if (key === 'query' || key === 'prepare')
        return (sql: string) => {
          const statement = Reflect.apply(method, target, [sql]) as Statement;
          // Bun 1.4.3 does not expose Statement.readonly; runtime reads use these SQL forms.
          const readonly = statement.readonly ?? /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql);
          return new Proxy(statement, {
            get(stmt, field) {
              const fn = Reflect.get(stmt, field, stmt);
              if (typeof fn !== 'function') return fn;
              if (field !== 'run') {
                if (!readonly && ['get', 'all', 'values', 'iterate'].includes(String(field)))
                  throw new Error('Durable mutations must use run(), not a row-returning statement');
                return fn.bind(stmt);
              }
              return (...args: SQLQueryBindings[]) => {
                check();
                const result = Reflect.apply(fn, stmt, args) as Changes;
                if (!readonly) record({ sql, args: structuredClone(args), changes: result.changes });
                return result;
              };
            }
          });
        };
      if (key === 'run' || key === 'exec')
        return (sql: string, ...args: unknown[]) => {
          check();
          const result = Reflect.apply(method, target, [sql, ...args]) as Changes;
          const bindings = (Array.isArray(args[0]) ? args[0] : args) as SQLQueryBindings[];
          record({ sql, args: structuredClone(bindings), exec: !bindings.length, changes: result.changes });
          return result;
        };
      if (key === 'transaction')
        return (run: (...args: unknown[]) => unknown) => {
          const native = Reflect.apply(method, target, [run]) as ReturnType<Database['transaction']>;
          const wrap =
            (call: (...args: unknown[]) => unknown) =>
            (...args: unknown[]) => {
              check();
              const parent = transaction;
              const writes: Write[] = [];
              transaction = writes;
              try {
                const result = Reflect.apply(call, native, args);
                if (parent) parent.push(...writes);
                else enqueue(writes);
                return result;
              } finally {
                transaction = parent;
              }
            };
          return Object.assign(wrap(native), {
            immediate: wrap(native.immediate),
            deferred: wrap(native.deferred),
            exclusive: wrap(native.exclusive)
          });
        };
      return method.bind(target);
    }
  });
  timer = setInterval(send, 5000);
  timer.unref();
  const flush = () => {
    check();
    const through = queue.sequence;
    if (committed >= through) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiting.push({ through, resolve, reject });
      send();
    });
  };
  return {
    database,
    flush,
    statistics: () => ({
      pendingBytes: queue.pendingBytes,
      softBytes: queue.softBytes,
      inflightBytes,
      commitMs,
      maxCommitMs,
      waiting: waiting.length,
      failure: failure?.message ?? null,
      coalesced: queue.coalesced,
      dropped: queue.dropped,
      overflow: queue.overflow,
      commits,
      committed,
      submitted: queue.sequence
    }),
    async close() {
      clearInterval(timer);
      try {
        await flush();
        const stopped = new Promise<void>((resolve) => {
          finishClose = resolve;
        });
        worker.postMessage({ close: true });
        await Promise.race([stopped, Bun.sleep(1000)]);
      } finally {
        closed = true;
        await worker.terminate();
      }
    }
  };
}
