import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { GameFile } from '../client/files';
import { assetPath } from './assets';
import { createManifest } from './client-files';
import { loadShard } from './config';
import type { RailwayState } from './deploy';
import { command } from './process';

const root = assetPath('client');

export async function deployClient(directory: string, assets: string, preparedFiles?: GameFile[]) {
  directory = resolve(directory);
  assets = resolve(assets);
  const shard = await loadShard(directory);
  const railway: RailwayState = JSON.parse(await readFile(join(directory, '.gemwright/railway.json'), 'utf8'));
  if (!railway.project || !railway.service) throw new Error('Deploy the shard first with gemwright deploy.');
  const run = async <T>(args: string[]): Promise<T> => JSON.parse(await command(['railway', ...args], directory));
  const projectFlags = ['--project', railway.project, '--environment', railway.environment];
  const services = await run<{ id: string; name: string }[]>(['service', 'list', ...projectFlags, '--json']);
  const server = services.find((service) => service.id === railway.service);
  if (!server) throw new Error('The recorded shard service is no longer in this Railway project.');

  const statePath = join(directory, '.gemwright/webclient.json');
  const state: { service?: string; volume?: string; assets?: string; url?: string } = await readFile(
    statePath,
    'utf8'
  ).then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return {};
  });
  const save = async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    await rename(`${statePath}.tmp`, statePath);
  };
  const files = preparedFiles ?? (await createManifest(assets));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  if (!state.service || !services.some((service) => service.id === state.service)) {
    const name = `${server.name}-web`;
    const existing = services.find((service) => service.name === name);
    if (existing) state.service = existing.id;
    else {
      await run(['link', ...projectFlags, '--json']);
      state.service = (await run<{ id: string }>(['add', '--service', name, '--json'])).id;
    }
    delete state.volume;
    delete state.assets;
    delete state.url;
    await save();
  }
  const flags = [...projectFlags, '--service', state.service];
  const volumes = await run<{ volumes: { id: string; serviceName: string; mountPath: string }[] }>([
    'volume',
    ...flags,
    'list',
    '--json'
  ]);
  const serviceName = `${server.name}-web`;
  const volume = volumes.volumes.find(
    (volume) => volume.serviceName === serviceName && volume.mountPath === '/app/data'
  );
  if (!volume || state.volume !== volume.id) {
    state.volume =
      volume?.id ?? (await run<{ id: string }>(['volume', ...flags, 'add', '--mount-path', '/app/data', '--json'])).id;
    delete state.assets;
    await save();
  }
  const domain = await run<{ domain?: string; domains?: string[] }>(['domain', ...flags, '--port', '3000', '--json']);
  const origin = domain.domain ?? domain.domains?.[0];
  if (!origin) throw new Error('Railway did not return a public domain for the client.');
  state.url = origin;
  await save();
  await run([
    'variable',
    'set',
    ...flags,
    `UO_HOST=\${{${server.name}.RAILWAY_PRIVATE_DOMAIN}}`,
    'UO_PORT=2593',
    'PORT=3000',
    `PUBLIC_ORIGIN=${origin}`,
    `SERVER_NAME=${shard.name}`,
    `UO_CLIENT_VERSION=${process.env.UO_CLIENT_VERSION ?? '7.0.45.1'}`,
    `UO_ENCRYPTION=${process.env.UO_ENCRYPTION ?? '0'}`,
    'RAILWAY_DOCKERFILE_PATH=Dockerfile',
    '--skip-deploys',
    '--json'
  ]);
  console.log('Deploying the web client...');
  const upload = await command(['railway', 'up', root, '--path-as-root', ...flags, '--detach', '--json'], root);
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
      if (state.assets !== digest) {
        console.log(`Uploading ${files.length} game files to the web client's volume...`);
        const staging = join(directory, '.gemwright/webclient-files');
        const upload = join(staging, 'gamefiles');
        await rm(staging, { recursive: true, force: true });
        try {
          for (const file of files) {
            const target = join(upload, file.path);
            await mkdir(dirname(target), { recursive: true });
            await link(join(assets, file.path), target).catch((error) => {
              if (error.code !== 'EXDEV') throw error;
              return copyFile(join(assets, file.path), target);
            });
          }
          await writeFile(join(upload, 'manifest.json'), `${JSON.stringify({ files })}\n`);
          await run([
            'volume',
            ...flags,
            'files',
            '--volume',
            state.volume,
            'upload',
            upload,
            '/',
            '--overwrite',
            '--json'
          ]);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        state.assets = digest;
        await save();
      }
      const health = await fetch(`${origin}/healthz`);
      if (!health.ok) throw new Error(`The deployed client health check returned ${health.status}.`);
      console.log(`ClassicUO: ${origin}`);
      return origin;
    }
    if (status && ['FAILED', 'CRASHED', 'REMOVED'].includes(status))
      throw new Error(`Client deployment ${status.toLowerCase()}. Inspect railway logs for service ${state.service}.`);
    if (attempt % 6 === 0) console.log(`Waiting for web client: ${status ?? 'pending'}...`);
    await sleep(5000);
  }
  throw new Error('Client deployment is still pending; rerun gemwright deploy --client to resume.');
}
