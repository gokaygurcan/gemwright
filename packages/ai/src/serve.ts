import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clientVersion, decisionProviders } from '@gemwright/common/config/shard';
import type { DecisionSettings } from '@gemwright/common/config/types';
import { validateConnection } from '@gemwright/network/connection';

import { useShardAreas } from './area-build';
import { setPopulationChaos } from './chaos';
import { type PopulationConfig, validateConfig } from './config';
import { setDebug } from './debug';
import { validateDecisionConfig } from './decision-provider';
import { setWars } from './guild-wars';
import { logger, logToStdout } from './log';
import { startExport, stopExport } from './otlp-export';
import { enablePhrasing } from './phrasing';
import { useShardRoutes } from './route-build';
import { runPopulation } from './run-population';
import { checkProvisioning, loadShardProfile } from './shard-profile';
import { useShardWorld } from './shard-world';
import { readShardWorld } from './spawns';
import { ResidentStore } from './store';
import { Terrain } from './terrain';
import { buildWorkAreas } from './work-area-build';
import { applyWorld, type Cohorts, useCities, world } from './world';

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
    decisions?: DecisionSettings;
    speech?: string;
    chaos?: number;
    wars?: boolean;
    cohorts?: Cohorts;
    debug?: boolean;
    cities?: string[];
  };
};
enablePhrasing(shard.ai?.speech === 'claude');
// Visible debugging (debug.ts): every resident emotes the phase it is in above its head.
setDebug(shard.ai?.debug === true);
if (shard.ai?.debug) logger('debug').info('ai.debug is on: residents emote their phase above their heads');
// How unpredictable residents are (chaos.ts): the shard's setting, else the world's, else 0.3.
setPopulationChaos(shard.ai?.chaos ?? world.lifecycle?.chaos ?? 0.3);
// Order and Chaos guild wars (guild-wars.ts) only when the shard turns them on.
setWars(shard.ai?.wars === true);
// The cities residents may go to (world.ts useCities): every city when unset.
useCities(shard.ai?.cities);
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
  profile: `classic-${clientVersion(shard)}`,
  host: required('UO_HOST'),
  port: Number(process.env.UO_PORT ?? 2593),
  serverIndex: 0,
  timeoutMs: 20000
});
const decisionConfig = validateDecisionConfig({
  providers: decisionProviders(shard.ai?.decisions),
  minIntervalMs: 5000,
  maxRequestsPerRun: 1000,
  maxRequestsPerDay: 200,
  share: shard.ai?.decisions === 'jev' ? 0.5 : 1
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
// The shard's own spawners (the deployment's world files) decide where vendors stand and residents
// hunt; with no residents to run there is no land to learn.
if (count > 0) {
  const shardWorld = readShardWorld(join(data, 'world'));
  if (!shardWorld)
    throw new Error(
      `No world files in ${join(data, 'world')} (Spawns/ and Regions.xml): run gemwright shard deploy --ai to upload them.`
    );
  useShardWorld(shardWorld);
  logger('serve').info(`[serve] vendors and hunting grounds from ${shardWorld.spawners.length} spawners`);
  const terrain = Terrain.shared(join(data, 'assets'), 1);
  // Where each town's mines and woods lie, from the map.
  buildWorkAreas(terrain);
  // Which places can be walked to from which, and the public roads long walks follow: kept on the
  // volume, built again only for a new world or map.
  await useShardAreas(data, terrain, join(data, 'assets'), shardWorld.teleporters);
  useShardRoutes(data, terrain, join(data, 'assets'));
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
      decisionConfig,
      assets: join(data, 'assets'),
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
