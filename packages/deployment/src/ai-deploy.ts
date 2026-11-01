import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { clientVersion } from '@gemwright/common/config/shard';
import type { ShardConfig } from '@gemwright/common/config/types';

import { packageClientFiles } from './client-files';
import { command } from './process';
import { waitForReadiness } from './providers/railway';
import { required } from './required';
import { checkAi, ensureService } from './service';

// The map files AI residents walk by: Trammel's map, statics and their index, and tiledata.
const mapPattern = /^(?:map1LegacyMUL\.uop|map1\.mul|statics1\.mul|staidx1\.mul|tiledata\.mul)$/i;

// Deploys the AI residents as their own Railway service beside the shard (`<shard>-ai`), with a
// volume for the resident database and map files. It reaches ServUO over the private network,
// and the shard trusts its private address through the AI patch (GEMWRIGHT_TRUSTED_HOSTS).
interface Dependencies {
  loadShard: (directory: string) => Promise<ShardConfig>;
  stageImage: (image: 'ai' | 'client', context: string) => Promise<void>;
  progress?: (message: string) => void;
}
export async function deployAi(dependencies: Dependencies, directory: string, gameFiles: string) {
  const { loadShard, stageImage, progress = () => {} } = dependencies;
  directory = resolve(directory);
  const shard = await loadShard(directory);
  if (shard.emulator !== 'servuo') throw new Error('AI residents support ServUO shards only.');
  const run = async <T>(args: string[]): Promise<T> => JSON.parse(await command(['railway', ...args], directory));
  const target = await checkAi(directory, shard, run);
  // Validate assets and image before creating services, volumes or variables.
  const maps = await packageClientFiles(directory, gameFiles, mapPattern, (names) => {
    if (!names.includes('tiledata.mul') || !names.some((n) => n.startsWith('map1')))
      throw new Error('AI residents need tiledata.mul and the Trammel map (map1LegacyMUL.uop or map1.mul).');
  });
  const context = await mkdtemp(join(tmpdir(), 'gemwright-ai-deploy-'));
  try {
    await stageImage('ai', context);
  } catch (error) {
    await rm(context, { recursive: true, force: true });
    throw error;
  }
  try {
    const name = `${target.name}-ai`;
    const { state, flags, save } = await ensureService(join(directory, '.gemwright/ai.json'), name, target, run);

    // Shard settings the AI needs (expansion, account rules, AI settings); never client paths.
    const settings = {
      id: shard.id,
      timezone: shard.timezone,
      emulator: shard.emulator,
      expansion: shard.expansion,
      client: { version: clientVersion(shard) },
      servuo: { autoCreateAccounts: shard.servuo?.autoCreateAccounts, accountsPerIp: shard.servuo?.accountsPerIp },
      ai: shard.ai ?? {}
    };
    const jev = shard.ai?.decisions === 'jev';
    // Without a key here, the one already set on the service is kept (it is never cleared).
    if (jev && !process.env.TYPESAFE_API_KEY)
      progress('ai.decisions is jev and TYPESAFE_API_KEY is not set here; keeping the key already on the service.');
    const claude = shard.ai?.speech === 'claude';
    if (claude && !process.env.ANTHROPIC_API_KEY)
      throw new Error('ai.speech is claude, but ANTHROPIC_API_KEY is not set in this environment.');
    await run([
      'variable',
      'set',
      ...flags,
      `UO_HOST=${target.host}`,
      `UO_PORT=${target.port}`,
      `GEMWRIGHT_SHARD=${JSON.stringify(settings)}`,
      ...(jev && process.env.TYPESAFE_API_KEY ? [`TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY}`] : []),
      ...(claude ? [`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`] : []),
      'RAILWAY_DOCKERFILE_PATH=Dockerfile',
      'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45',
      '--skip-deploys',
      '--json'
    ]);
    progress('Deploying the AI residents...');
    const upload = await command(
      ['railway', 'up', context, '--path-as-root', '--no-gitignore', ...flags, '--detach', '--json'],
      context
    );
    let deploymentId: string | undefined;
    for (const line of upload.split('\n')) {
      try {
        const value = JSON.parse(line);
        deploymentId = value.deploymentId ?? value.id ?? deploymentId;
      } catch {
        /* Railway also emits progress text. */
      }
    }
    if (!deploymentId)
      throw new Error('Railway returned no deployment ID. Inspect railway deployment list before retrying.');
    for (let attempt = 0; attempt < 120; attempt++) {
      const deployments = await run<{ id: string; status: string }[]>([
        'deployment',
        'list',
        ...flags,
        '--limit',
        '1',
        '--json'
      ]);
      const latest = deployments[0];
      const status = latest && (!deploymentId || latest.id === deploymentId) ? latest.status : undefined;
      if (status === 'SUCCESS') {
        if (state.assets !== maps.digest) {
          progress(`Uploading ${Math.round(maps.bytes / 1024 / 1024)} MiB of map files to the AI volume...`);
          const volumeFlags = ['volume', ...flags, 'files', '--volume', required(state.volume, 'Railway volume')];
          await run([...volumeFlags, 'upload', maps.archive, '/assets.tar.gz.uploading', '--overwrite', '--json']);
          await run([...volumeFlags, 'rename', '/assets.tar.gz.uploading', '/assets.tar.gz', '--json']);
          state.assets = maps.digest;
          await save();
          await run(['restart', ...flags, '--yes', '--json']);
        }
        await waitForReadiness(
          flags,
          'test -f /app/data/.ai-ready && test ! -f /app/data/assets.tar.gz',
          directory,
          'AI bootstrap'
        );
        progress(`AI residents deployed: ${shard.ai?.population ?? 10} residents, ${jev ? 'Jev' : 'local'} decisions.`);
        return;
      }
      if (status && ['FAILED', 'CRASHED', 'REMOVED'].includes(status))
        throw new Error(`AI deployment ${status.toLowerCase()}. Inspect: railway logs ${flags.join(' ')}.`);
      if (attempt % 6 === 0) progress(`Waiting for the AI service: ${status ?? 'pending'}...`);
      await sleep(5000);
    }
    throw new Error('AI deployment is still pending; rerun gemwright deploy --ai to resume.');
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
