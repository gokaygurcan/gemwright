import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type PopulationConfig, validateConfig } from './config';
import { validateConnection } from './connection';
import { validateDecisionConfig } from './decision-provider';
import { enablePhrasing } from './phrasing';
import { CLIENT_VERSION } from './protocol/packets';
import { runPopulation } from './run-population';
import { checkProvisioning, loadShardProfile } from './shard-profile';
import { ResidentStore } from './store';
import { applyWorld } from './world';

// The deployed AI service (gemwright deploy --ai): builds the population from world.json and the
// shard's AI settings, reconciles the roster, and keeps every resident online for as long as the
// container lives, creating accounts by ordinary login as needed. Configuration comes from the
// environment the deployment sets; all state lives on the /app/data volume.
const data = process.env.AI_DATA ?? '/app/data';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const shard = JSON.parse(required('GEMWRIGHT_SHARD')) as {
  id: string;
  ai?: { population?: number; decisions?: string; speech?: string };
};
enablePhrasing(shard.ai?.speech === 'claude');
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
        maxRequestsPerRun: 1000,
        maxRequestsPerDay: 5000,
        maxDailyCostUsd: 0.5
      }
    : { provider: 'local' }
);
const dbPath = join(data, 'residents.sqlite');
const store = new ResidentStore(dbPath, shard.id);
try {
  const reconciled = store.reconcile(population);
  console.error(
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
