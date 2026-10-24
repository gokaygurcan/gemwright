import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { archetypes } from './archetypes';
import { allocatePopulation, validateConfig } from './config';
import { validateConnection } from './connection';
import { validateDecisionConfig } from './decision-provider';
import { decisionReport, mergeDecisionMemory } from './decisions';
import { dungeonReport } from './dungeon-report';
import { enablePhrasing } from './phrasing';
import { runPopulation } from './run-population';
import { runSession } from './run-session';
import { checkProvisioning, loadShardProfile } from './shard-profile';
import { ResidentStore } from './store';

const help = `Gemwright AI runtime and headless player sessions

Run from the repository root:
  bun run packages/ai/src/index.ts archetypes
  bun run packages/ai/src/index.ts validate --config packages/ai/templates/population.example.json
  bun run packages/ai/src/index.ts plan --config packages/ai/templates/population.example.json
  bun run packages/ai/src/index.ts reconcile --config packages/ai/templates/population.example.json
  bun run packages/ai/src/index.ts residents --config packages/ai/templates/population.example.json
  bun run packages/ai/src/index.ts decisions --config <population.json>
  bun run packages/ai/src/index.ts skills --config <population.json>
  bun run packages/ai/src/index.ts dungeons --config <population.json>
  bun run packages/ai/src/index.ts session --config <population.json> --connection <connection.json>
  bun run packages/ai/src/index.ts population --config <population.json> --connection <connection.json> --assets <dir> --duration <s>

Options:
  --config <path>  Required, explicit population configuration
  --db <path>      Default: packages/ai/data/<shardId>/residents.sqlite (relative to this module)
  --help          Show this help

Session options:
  --connection <path>   Required endpoint/profile configuration
  --resident <id>       Default: first desired active resident
  --create-character   Explicitly allow local credentials and normal account/character creation
  --shard <path>       The shard's gemwright.json (expansion, account settings); ServUO only
  --speech claude      Replies in each resident's own voice (Claude Haiku 5.5; needs ANTHROPIC_API_KEY)
  --exercise           Walk, speak, open the backpack, and target with a miner's tool
  --reconnect          Disconnect and verify the same character can reconnect
  --reconnect-attempts  Recovery budget during observation, default 3, maximum 10
  --duration <seconds> Observe after entry/exercise, default 5, maximum 3600
  --decisions <path>    Optional Jev/local decision configuration (behavior sessions only)
  --fighter-assets <path> Run the Britain graveyard swordsman using public Trammel client assets
  --miner-assets <path> Run the Minoc miner behavior using public Trammel client assets

Population options (all desired-active residents in one process, one shard lease):
  --assets <path>       Public Trammel client assets; each template's activities pick miner or fighter
  --stagger <seconds>   Delay between resident logins, default 20
  --limit <count>       Run only the first N desired-active residents
  (also --connection, --create-character, --reconnect-attempts, --duration, --decisions)

reconcile persists desired residents; it does not create accounts or log anyone in.
residents displays local intentions, not actual online population.
decisions summarizes each resident's provider choices against the deterministic baseline.
dungeons summarizes recorded dungeon runs: solo runs, parties assembled or abandoned, and how they ended.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean' },
      connection: { type: 'string' },
      resident: { type: 'string' },
      'create-character': { type: 'boolean' },
      shard: { type: 'string' },
      speech: { type: 'string' },
      exercise: { type: 'boolean' },
      reconnect: { type: 'boolean' },
      'reconnect-attempts': { type: 'string' },
      duration: { type: 'string' },
      'miner-assets': { type: 'string' },
      'fighter-assets': { type: 'string' },
      decisions: { type: 'string' },
      assets: { type: 'string' },
      stagger: { type: 'string' },
      limit: { type: 'string' }
    }
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    ![
      'archetypes',
      'validate',
      'plan',
      'reconcile',
      'residents',
      'decisions',
      'skills',
      'dungeons',
      'session',
      'population'
    ].includes(command ?? '')
  )
    throw new Error('Unknown command; use --help');
  if (command === 'archetypes') {
    console.log(JSON.stringify({ schemaVersion: 1, archetypes }, null, 2));
    return;
  }
  if (!values.config) throw new Error('--config is required');
  const config = validateConfig(await Bun.file(resolve(values.config)).json());
  if (command === 'validate') {
    console.log(JSON.stringify({ valid: true, shardId: config.shardId, templates: config.templates.length }));
    return;
  }
  if (command === 'plan') {
    console.log(
      JSON.stringify(
        { shardId: config.shardId, targetPopulation: config.targetPopulation, allocation: allocatePopulation(config) },
        null,
        2
      )
    );
    return;
  }
  const path = values.db ? resolve(values.db) : resolve(import.meta.dir, '../data', config.shardId, 'residents.sqlite');
  if (command === 'session' || command === 'population') {
    const profile = await loadShardProfile(values.shard ? resolve(values.shard) : undefined);
    if (values.speech && values.speech !== 'claude' && values.speech !== 'authored')
      throw new Error('--speech must be claude or authored');
    enablePhrasing(values.speech === 'claude');
    console.error(`[profile] ServUO ${profile.protocol}, expansion ${profile.expansion}`);
    // New accounts come only from ordinary login; check the shard can make them before trying.
    if (values['create-character'] && (await Bun.file(path).exists())) {
      const store = new ResidentStore(path, config.shardId);
      try {
        const unbound = store
          .list()
          .filter((r) => r.desiredActive && !r.binding && (!values.resident || r.id === values.resident));
        checkProvisioning(unbound.filter((r) => !store.credentials(r.id)).length);
      } finally {
        store.close();
      }
    }
  }
  if (command === 'session') {
    if (!values.connection) throw new Error('--connection is required for a player session');
    const durationSeconds = Number(values.duration ?? 5);
    const reconnectAttempts = Number(values['reconnect-attempts'] ?? 3);
    if (!Number.isInteger(reconnectAttempts) || reconnectAttempts < 0 || reconnectAttempts > 10)
      throw new Error('--reconnect-attempts must be an integer from 0 to 10');
    if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 3600)
      throw new Error('--duration must be an integer from 0 to 3600');
    if (values['miner-assets'] && values['fighter-assets']) throw new Error('Choose one resident behavior per session');
    if ((values['miner-assets'] || values['fighter-assets']) && (values.exercise || values.reconnect))
      throw new Error('--miner-assets runs a behavior; use --exercise and --reconnect in separate sessions');
    if ((values['miner-assets'] || values['fighter-assets']) && !values.duration)
      throw new Error('Miner sessions require an explicit --duration in seconds');
    if (values.decisions && !values['miner-assets'] && !values['fighter-assets'])
      throw new Error('--decisions requires a miner or fighter behavior');
    const decisionConfig = values.decisions
      ? validateDecisionConfig(await Bun.file(resolve(values.decisions)).json())
      : undefined;
    const result = await runSession({
      population: config,
      connection: validateConnection(await Bun.file(resolve(values.connection)).json()),
      dbPath: path,
      residentId: values.resident,
      create: values['create-character'] ?? false,
      exercise: values.exercise ?? false,
      reconnect: values.reconnect ?? false,
      reconnectAttempts,
      durationSeconds,
      decisionConfig,
      minerAssets: values['miner-assets'] ? resolve(values['miner-assets']) : undefined,
      fighterAssets: values['fighter-assets'] ? resolve(values['fighter-assets']) : undefined
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'population') {
    if (!values.connection || !values.assets || !values.duration)
      throw new Error('population requires --connection, --assets, and --duration');
    const durationSeconds = Number(values.duration);
    const reconnectAttempts = Number(values['reconnect-attempts'] ?? 5);
    const staggerSeconds = Number(values.stagger ?? 20);
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600)
      throw new Error('--duration must be an integer from 1 to 3600');
    if (!Number.isInteger(reconnectAttempts) || reconnectAttempts < 0 || reconnectAttempts > 10)
      throw new Error('--reconnect-attempts must be an integer from 0 to 10');
    if (!Number.isInteger(staggerSeconds) || staggerSeconds < 0 || staggerSeconds > 600)
      throw new Error('--stagger must be an integer from 0 to 600');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be positive');
    const report = await runPopulation({
      population: config,
      connection: validateConnection(await Bun.file(resolve(values.connection)).json()),
      dbPath: path,
      create: values['create-character'] ?? false,
      reconnectAttempts,
      durationSeconds,
      decisionConfig: values.decisions
        ? validateDecisionConfig(await Bun.file(resolve(values.decisions)).json())
        : undefined,
      assets: resolve(values.assets),
      staggerSeconds,
      limit
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'skills') {
    if (!(await Bun.file(path).exists())) throw new Error('Resident database does not exist; run reconcile first');
    const store = new ResidentStore(path, config.shardId);
    try {
      // Last hourly snapshot per resident, and how many residents sit in each band of each skill.
      const residents = store.list().flatMap((resident) => {
        const snapshot = store.skillSnapshot(resident.id);
        return snapshot ? [{ resident, snapshot }] : [];
      });
      const bands: Record<string, Record<string, number>> = {};
      for (const { snapshot } of residents)
        for (const [skill, reading] of Object.entries(snapshot.skills)) {
          if (reading.base <= 0) continue;
          const band =
            reading.base >= 100
              ? '100+'
              : `${Math.floor(reading.base / 10) * 10}-${Math.floor(reading.base / 10) * 10 + 9.9}`;
          bands[skill] ??= {};
          bands[skill][band] = (bands[skill][band] ?? 0) + 1;
        }
      console.log(
        JSON.stringify(
          {
            residentsWithSnapshots: residents.length,
            grandmasters: residents.flatMap(({ resident, snapshot }) =>
              Object.entries(snapshot.skills)
                .filter(([, reading]) => reading.base >= 100)
                .map(([skill, reading]) => ({ name: resident.proposedName, skill, base: reading.base }))
            ),
            bands
          },
          null,
          2
        )
      );
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'dungeons') {
    if (!(await Bun.file(path).exists())) throw new Error('Resident database does not exist; run reconcile first');
    const store = new ResidentStore(path, config.shardId);
    try {
      console.log(JSON.stringify(dungeonReport(store.dungeonRuns()), null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'decisions') {
    if (!(await Bun.file(path).exists())) throw new Error('Resident database does not exist; run reconcile first');
    const store = new ResidentStore(path, config.shardId);
    try {
      const residents = store.list();
      const report = residents.map((resident) => ({
        id: resident.id,
        template: resident.templateId,
        kinds: decisionReport(resident.checkpoint.decisions)
      }));
      // Fleet comparison: every resident's tallies summed per kind, and how many recent decisions
      // Jev actually made versus the local rule (with the reason it was not asked).
      const fleet = mergeDecisionMemory(residents.map((resident) => resident.checkpoint.decisions));
      console.log(
        JSON.stringify({ fleet: { kinds: decisionReport(fleet.memory), sources: fleet.sources }, report }, null, 2)
      );
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'residents' && !(await Bun.file(path).exists()))
    throw new Error('Resident database does not exist; run reconcile first');
  const store = new ResidentStore(path, config.shardId);
  try {
    console.log(JSON.stringify(command === 'reconcile' ? store.reconcile(config) : store.list(), null, 2));
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'AI foundation command failed');
  process.exitCode = 1;
}
