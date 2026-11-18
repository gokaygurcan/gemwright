import { parentPort, workerData } from 'node:worker_threads';

import { JournalFiles } from './journal-files';
import type { TelemetryEvent } from './telemetry-schema';

const files = new JournalFiles(String(workerData.directory));
await files.initialize();
let chain = Promise.resolve();
parentPort?.on('message', (message: { events: TelemetryEvent[]; through: number }) => {
  chain = chain
    .then(async () => {
      await files.write(message.events);
      parentPort?.postMessage({ through: message.through, storage: files.statistics() });
    })
    .catch((error: unknown) =>
      parentPort?.postMessage({
        problem: `Life-event journal could not be saved: ${error instanceof Error ? error.message : String(error)}`
      })
    );
});
parentPort?.postMessage({ ready: true });
