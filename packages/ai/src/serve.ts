import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clientVersion } from '@gemwright/common/config/shard';
import { validateConnection } from '@gemwright/network/connection';

import { type PopulationConfig, validateConfig } from './config';
import { setDebug } from './debug';
import { prepareLand } from './land';
import { logger, logToStdout } from './log';
import { startExport, stopExport } from './otlp-export';
import { runPopulation } from './run-population';
import { confine } from './shadow';
import { checkProvisioning, loadShardProfile } from './shard-profile';
import { ResidentStore } from './store';
import { applyWorld, checkCities } from './world';

// The deployed AI service (gemwright shard deploy --ai): builds the population from world.json and the
// shard's AI settings, reconciles the roster, and keeps every resident online for as long as the
// container lives, creating accounts by ordinary login as needed. Configuration comes from the
// environment the deployment sets; all state lives on the /app/data volume.
// A service: progress goes to stdout, so the host's error view shows only failures.
logToStdout();
startExport();

const data = process.env.AI_DATA ?? '/app/data';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const shard = JSON.parse(required('GEMWRIGHT_SHARD')) as {
  id: string;
  client?: { version: string };
  ai?: {
    population?: number;
    debug?: boolean;
    cities?: string[];
  };
};
// Visible debugging (debug.ts): every resident emotes the phase it is in above its head.
setDebug(shard.ai?.debug === true);
if (shard.ai?.debug) logger('debug').info('ai.debug is on: residents emote their phase above their heads');
// The cities residents are kept to: every city when unset.
checkCities(shard.ai?.cities);
confine(shard.ai?.cities);
const shardFile = join(data, 'gemwright.json');
await mkdir(data, { recursive: true });
await writeFile(shardFile, JSON.stringify(shard));
const profile = await loadShardProfile(shardFile);
const count = Number(shard.ai?.population ?? 10);
if (!Number.isInteger(count) || count < 0) throw new Error('ai.population must be a non-negative integer');

const base = {
  schemaVersion: 1,
  shardId: shard.id,
  targetPopulation: 0,
  templates: [],
  allocation: { mode: 'fixed', entries: [] }
};
const population: PopulationConfig = validateConfig(applyWorld(base as unknown as PopulationConfig, count));
await writeFile(join(data, 'population.json'), `${JSON.stringify(population, null, 2)}\n`);
const connection = validateConnection({
  schemaVersion: 1,
  shardId: shard.id,
  emulator: 'servuo',
  profile: `classic-${clientVersion(shard)}`,
  host: required('UO_HOST'),
  port: Number(process.env.UO_PORT ?? 2593),
  serverIndex: 0,
  timeoutMs: 20000
});
const dbPath = join(data, 'residents.sqlite');
const store = new ResidentStore(dbPath, shard.id);
try {
  // Residents retired by hand (retired.json in the data folder) no longer log in and are not replaced.
  const reconciled = store.reconcile(population);
  logger('serve').info(
    `[serve] ${profile.expansion} shard ${shard.id}: ${reconciled.active} residents active, ${reconciled.created} new`
  );
  checkProvisioning(store.list().filter((r) => r.desiredActive && !r.binding && !store.credentials(r.id)).length);
} finally {
  store.close();
}

await writeFile(join(data, '.ai-ready'), String(process.pid));

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    stopping = true;
  });
// With no residents to run there is no land to learn.
if (count > 0) {
  await prepareLand(data, shard.ai?.cities);
}
while (!stopping) {
  const started = Date.now();
  try {
    await runPopulation({
      population,
      connection,
      dbPath,
      create: true,
      reconnectAttempts: 5,
      durationSeconds: Number.POSITIVE_INFINITY,
      staggerSeconds: 2,
      continuous: true
    });
  } catch (error) {
    logger('serve').error(`[serve] population round failed: ${error instanceof Error ? error.message : error}`);
  }
  // A round that ends early (no residents, a failure) waits before the next one.
  while (!stopping && Date.now() - started < 60_000) await Bun.sleep(1000);
}
await stopExport();
