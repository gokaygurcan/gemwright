import { parentPort, workerData } from 'node:worker_threads';

import { RouteCorridors } from './path-corridors';
import type { RouteRequest } from './path-search';
import type { Corridor } from './route-waypoints';
import { Terrain } from './terrain';

const terrain = Terrain.shared(workerData.directory, workerData.facet, workerData.buffers);
const search = new RouteCorridors();
search.useCorridors(workerData.corridors ?? []);
parentPort?.on(
  'message',
  (message: { id: number; request: RouteRequest; cancellation: SharedArrayBuffer } | { corridors: Corridor[] }) => {
    if ('corridors' in message) return search.useCorridors(message.corridors);
    const cancelled = new Int32Array(message.cancellation);
    try {
      const result = search.run(terrain, message.request, () => Atomics.load(cancelled, 0) !== 0);
      parentPort?.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
);
