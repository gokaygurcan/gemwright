import { Database } from 'bun:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import type { Write } from './persistence-queue';
import { ResidentStore } from './store';

const { path, shardId } = workerData as { path: string; shardId: string };
let database: Database;
try {
  const setup = new ResidentStore(path, shardId);
  setup.close();
  database = new Database(path, { strict: true });
  database.exec(
    'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;'
  );
  const snapshot = database.serialize();
  // Deserialized memory databases use rollback journaling, not an on-disk WAL sidecar.
  snapshot[18] = 1;
  snapshot[19] = 1;
  parentPort?.postMessage({ snapshot });
} catch {
  parentPort?.postMessage({ problem: 'Could not open the durable resident database' });
  throw new Error('Persistence initialization failed');
}
parentPort?.on('message', (message: { writes?: Write[]; through?: number; close?: boolean }) => {
  try {
    if (message.close) {
      database.close();
      parentPort?.postMessage({ closed: true });
      parentPort?.close();
      return;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const write of message.writes ?? []) {
        if (write.exec) database.exec(write.sql);
        else {
          const result = database.query(write.sql).run(...write.args);
          if (write.changes !== undefined && result.changes !== write.changes)
            throw new Error('Durable database revision conflict');
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    parentPort?.postMessage({ through: message.through });
  } catch {
    parentPort?.postMessage({ problem: 'Durable resident write failed; runtime must stop' });
  }
});
