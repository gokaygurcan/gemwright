import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setPopulationChaos } from './chaos';
import { type PopulationConfig, validateConfig } from './config';
import { validateConnection } from './connection';
import { validateDecisionConfig } from './decision-provider';
import { setWars } from './guild-wars';
import { info, logToStdout } from './log';
import { enablePhrasing } from './phrasing';
import { CLIENT_VERSION } from './protocol/packets';
import { runPopulation } from './run-population';
import { checkProvisioning, loadShardProfile } from './shard-profile';
import { ResidentStore } from './store';
import { applyWorld, type Cohorts, world } from './world';

// The deployed AI service (gemwright deploy --ai): builds the population from world.json and the
// shard's AI settings, reconciles the roster, and keeps every resident online for as long as the
// container lives, creating accounts by ordinary login as needed. Configuration comes from the
// environment the deployment sets; all state lives on the /app/data volume.
// A service: progress goes to stdout, so the host's error view shows only failures.
logToStdout();

const data = process.env.AI_DATA ?? '/app/data';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const shard = JSON.parse(required('GEMWRIGHT_SHARD')) as {
  id: string;
  ai?: { population?: number; decisions?: string; speech?: string; chaos?: number; wars?: boolean; cohorts?: Cohorts };
};
enablePhrasing(shard.ai?.speech === 'claude');
// How unpredictable residents are (chaos.ts): the shard's setting, else the world's, else 0.3.
setPopulationChaos(shard.ai?.chaos ?? world.lifecycle?.chaos ?? 0.3);
// Order and Chaos guild wars (guild-wars.ts) only when the shard turns them on.
setWars(shard.ai?.wars === true);
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
const population: PopulationConfig = validateConfig(
  applyWorld(base as unknown as PopulationConfig, count, shard.ai?.cohorts)
);
await writeFile(join(data, 'population.json'), `${JSON.stringify(population, null, 2)}\n`);
const connection = validateConnection({
  schemaVersion: 1,
  shardId: shard.id,
  emulator: 'servuo',
  profile: `classic-${CLIENT_VERSION}`,
  host: required('UO_HOST'),
  port: Number(process.env.UO_PORT ?? 2593),
  serverIndex: 0,
  timeoutMs: 20000
});
const decisionConfig = validateDecisionConfig(
  shard.ai?.decisions === 'jev' && process.env.TYPESAFE_API_KEY
    ? {
        provider: 'jev',
        model: 'jev-1.13.0',
        minIntervalMs: 5000,
        // Every resident shares one daily budget: $0.16 a day keeps the population under $5 a month.
        maxRequestsPerRun: 1000,
        maxRequestsPerDay: 200,
        maxDailyCostUsd: 0.02,
        maxPopulationDailyCostUsd: 0.16,
        // Half the residents ask Jev, half decide locally, to compare them (analyze /decisions).
        share: 0.5
      }
    : { provider: 'local' }
);
const dbPath = join(data, 'residents.sqlite');
const store = new ResidentStore(dbPath, shard.id);
try {
  // Residents retired by hand (retired.json in the data folder) no longer log in and are not replaced.
  const reconciled = store.reconcile(population);
  info(
    `[serve] ${profile.expansion} shard ${shard.id}: ${reconciled.active} residents active, ${reconciled.created} new`
  );
  checkProvisioning(store.list().filter((r) => r.desiredActive && !r.binding && !store.credentials(r.id)).length);
} finally {
  store.close();
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    stopping = true;
  });
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
      decisionConfig,
      assets: join(data, 'assets'),
      staggerSeconds: 2,
      continuous: true
    });
  } catch (error) {
    console.error(`[serve] population round failed: ${error instanceof Error ? error.message : error}`);
  }
  // A round that ends early (no residents, a failure) waits before the next one.
  while (!stopping && Date.now() - started < 60_000) await Bun.sleep(1000);
}
