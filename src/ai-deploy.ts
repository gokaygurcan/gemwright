import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { assetPath } from './assets';
import { packageClientFiles } from './client-files';
import { loadShard } from './config';
import type { RailwayState } from './deploy';
import { command } from './process';

// The map files AI residents walk by: Trammel's map, statics and their index, and tiledata.
const mapPattern = /^(?:map1LegacyMUL\.uop|map1\.mul|statics1\.mul|staidx1\.mul|tiledata\.mul)$/i;

// Deploys the AI residents as their own Railway service beside the shard (`<shard>-ai`), with a
// volume for the resident database and map files. It reaches ServUO over the private network,
// and the shard trusts its private address through the AI patch (GEMWRIGHT_TRUSTED_HOSTS).
export async function deployAi(directory: string, gameFiles: string) {
  directory = resolve(directory);
  const shard = await loadShard(directory);
  if (shard.emulator !== 'servuo') throw new Error('AI residents support ServUO shards only.');
  const railway: RailwayState = JSON.parse(await readFile(join(directory, '.gemwright/railway.json'), 'utf8'));
  if (!railway.project || !railway.service)
    throw new Error('Deploy the shard first with gemwright deploy --server --ai.');
  if (!railway.aiPatched)
    throw new Error('The shard was built without the AI patch. Run gemwright deploy --server --ai once.');
  const run = async <T>(args: string[]): Promise<T> => JSON.parse(await command(['railway', ...args], directory));
  const projectFlags = ['--project', railway.project, '--environment', railway.environment];
  const services = await run<{ id: string; name: string }[]>(['service', 'list', ...projectFlags, '--json']);
  const server = services.find((service) => service.id === railway.service);
  if (!server) throw new Error('The recorded shard service is no longer in this Railway project.');

  const statePath = join(directory, '.gemwright/ai.json');
  const state: { service?: string; volume?: string; assets?: string } = await readFile(statePath, 'utf8').then(
    (text) => JSON.parse(text),
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  );
  const save = async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    await rename(`${statePath}.tmp`, statePath);
  };
  const name = `${server.name}-ai`;
  if (!state.service || !services.some((service) => service.id === state.service)) {
    const existing = services.find((service) => service.name === name);
    if (existing) state.service = existing.id;
    else {
      await run(['link', ...projectFlags, '--json']);
      state.service = (await run<{ id: string }>(['add', '--service', name, '--json'])).id;
    }
    delete state.volume;
    delete state.assets;
    await save();
  }
  const flags = [...projectFlags, '--service', state.service];
  const volumes = await run<{ volumes: { id: string; serviceName: string; mountPath: string }[] }>([
    'volume',
    ...flags,
    'list',
    '--json'
  ]);
  const volume = volumes.volumes.find((entry) => entry.serviceName === name && entry.mountPath === '/app/data');
  if (!volume || state.volume !== volume.id) {
    state.volume =
      volume?.id ?? (await run<{ id: string }>(['volume', ...flags, 'add', '--mount-path', '/app/data', '--json'])).id;
    delete state.assets;
    await save();
  }

  // Shard settings the AI needs (expansion, account rules, AI settings); never client paths.
  const settings = {
    id: shard.id,
    emulator: shard.emulator,
    expansion: shard.expansion,
    servuo: { autoCreateAccounts: shard.servuo?.autoCreateAccounts, accountsPerIp: shard.servuo?.accountsPerIp },
    ai: shard.ai ?? {}
  };
  const jev = shard.ai?.decisions === 'jev';
  if (jev && !process.env.TYPESAFE_API_KEY)
    throw new Error('ai.decisions is jev, but TYPESAFE_API_KEY is not set in this environment.');
  const claude = shard.ai?.speech === 'claude';
  if (claude && !process.env.ANTHROPIC_API_KEY)
    throw new Error('ai.speech is claude, but ANTHROPIC_API_KEY is not set in this environment.');
  await run([
    'variable',
    'set',
    ...flags,
    `UO_HOST=\${{${server.name}.RAILWAY_PRIVATE_DOMAIN}}`,
    'UO_PORT=2593',
    `GEMWRIGHT_SHARD=${JSON.stringify(settings)}`,
    ...(jev ? [`TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY}`] : []),
    ...(claude ? [`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`] : []),
    'RAILWAY_DOCKERFILE_PATH=Dockerfile',
    '--skip-deploys',
    '--json'
  ]);
  // The shard exempts the AI's private address from per-address account and login limits. Setting
  // a variable redeploys the shard, so it is set only when it changes.
  const trusted = `\${{${name}.RAILWAY_PRIVATE_DOMAIN}}`;
  const serverFlags = [...projectFlags, '--service', railway.service];
  const current = await run<Record<string, string>>(['variable', 'list', ...serverFlags, '--json']).catch(
    () => ({}) as Record<string, string>
  );
  if (current.GEMWRIGHT_TRUSTED_HOSTS !== `${name}.railway.internal`) {
    console.log('Letting the shard trust the AI service (the shard restarts once)...');
    await run(['variable', 'set', ...serverFlags, `GEMWRIGHT_TRUSTED_HOSTS=${trusted}`, '--json']);
  }

  console.log('Deploying the AI residents...');
  const context = await mkdtemp(join(tmpdir(), 'gemwright-ai-deploy-'));
  let upload: string;
  try {
    await cp(assetPath('ai/Dockerfile'), join(context, 'Dockerfile'));
    await cp(assetPath('ai/railway.json'), join(context, 'railway.json'));
    await mkdir(join(context, 'client'));
    await cp(assetPath('client/huffman.ts'), join(context, 'client/huffman.ts'));
    for (const path of [
      'package.json',
      'bun.lock',
      'tsconfig.json',
      'start.sh',
      'src',
      'world',
      'templates',
      'locations',
      'catalogs'
    ])
      await cp(assetPath(`ai/${path}`), join(context, 'ai', path), { recursive: true });
    upload = await command(
      ['railway', 'up', context, '--path-as-root', '--no-gitignore', ...flags, '--detach', '--json'],
      context
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  let deploymentId: string | undefined;
  for (const line of upload.split('\n')) {
    try {
      const value = JSON.parse(line);
      deploymentId = value.deploymentId ?? value.id ?? deploymentId;
    } catch {
      /* Railway also emits progress text. */
    }
  }
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
      const maps = await packageClientFiles(directory, gameFiles, mapPattern, (names) => {
        if (!names.includes('tiledata.mul') || !names.some((n) => n.startsWith('map1')))
          throw new Error('AI residents need tiledata.mul and the Trammel map (map1LegacyMUL.uop or map1.mul).');
      });
      if (state.assets !== maps.digest) {
        console.log(`Uploading ${Math.round(maps.bytes / 1024 / 1024)} MiB of map files to the AI volume...`);
        const volumeFlags = ['volume', ...flags, 'files', '--volume', state.volume];
        await run([...volumeFlags, 'upload', maps.archive, '/assets.tar.gz.uploading', '--overwrite', '--json']);
        await run([...volumeFlags, 'rename', '/assets.tar.gz.uploading', '/assets.tar.gz', '--json']);
        state.assets = maps.digest;
        await save();
      }
      console.log(
        `AI residents deployed: ${shard.ai?.population ?? 10} residents, ${jev ? 'Jev' : 'local'} decisions.`
      );
      return;
    }
    if (status && ['FAILED', 'CRASHED', 'REMOVED'].includes(status))
      throw new Error(`AI deployment ${status.toLowerCase()}. Inspect railway logs for service ${name}.`);
    if (attempt % 6 === 0) console.log(`Waiting for the AI service: ${status ?? 'pending'}...`);
    await sleep(5000);
  }
  throw new Error('AI deployment is still pending; rerun gemwright deploy --ai to resume.');
}
