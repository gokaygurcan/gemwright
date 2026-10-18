import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { deployClient } from './client-deploy';
import { createManifest } from './client-files';
import { type Emulator, loadShard } from './config';
import { stageDotnet, validateDotnetShard } from './emulators/dotnet/staging';
import { packageClientFiles as packageServuoFiles, stageServuo, validateServuoShard } from './emulators/servuo/staging';
import { packageClientFiles as packageSphereFiles, stageSphere, validateSphereShard } from './emulators/sphere/staging';
import { command, isAvailable } from './process';
export const deployments = {
  runuo: { label: 'RunUO', validate: validateDotnetShard, stage: stageDotnet, packageFiles: packageServuoFiles },
  modernuo: { label: 'ModernUO', validate: validateDotnetShard, stage: stageDotnet, packageFiles: packageServuoFiles },
  servuo: { label: 'ServUO', validate: validateServuoShard, stage: stageServuo, packageFiles: packageServuoFiles },
  'sphere-x': {
    label: 'Sphere-X',
    validate: validateSphereShard,
    stage: stageSphere,
    packageFiles: packageSphereFiles
  },
  sphere: { label: 'Sphere', validate: validateSphereShard, stage: stageSphere, packageFiles: packageSphereFiles }
};

export interface RailwayState {
  projectName: string;
  emulator?: Emulator;
  project?: string;
  service?: string;
  environment: string;
  volume?: string;
  clientDigest?: string;
  pendingClientDigest?: string;
  mysql?: { service?: string; name: string; creating?: boolean };
}
export type RailwayCommand = <T>(args: string[]) => Promise<T>;
async function saveState(directory: string, state: RailwayState): Promise<void> {
  const path = join(directory, '.gemwright/railway.json');
  await mkdir(join(directory, '.gemwright'), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
export async function ensureRailway(
  directory: string,
  slug: string,
  run: RailwayCommand,
  pause: (ms: number) => Promise<unknown> = sleep
): Promise<RailwayState> {
  let state: RailwayState;
  try {
    state = JSON.parse(await readFile(join(directory, '.gemwright/railway.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { projectName: `${slug}-${randomUUID().slice(0, 8)}`, environment: 'production' };
    await saveState(directory, state);
  }
  if (!state.projectName || !state.environment) throw new Error('Invalid .gemwright/railway.json state.');
  if (!state.project) {
    const projects = await run<{ id: string; name: string; deletedAt: string | null }[]>(['project', 'list', '--json']);
    const matches = projects.filter((project) => project.name === state.projectName && !project.deletedAt);
    if (matches.length > 1) throw new Error('Multiple projects match the recorded provisioning name.');
    if (matches.length) state.project = matches[0]!.id;
    else {
      const account = await run<{ workspaces: { id: string; name: string }[] }>(['whoami', '--json']);
      if (account.workspaces.length !== 1)
        throw new Error(
          'Deployment currently requires a single Railway workspace, or a project already recorded in .gemwright/railway.json.'
        );
      const project = await run<{ id: string }>([
        'init',
        '--name',
        state.projectName,
        '--workspace',
        account.workspaces[0]!.id,
        '--json'
      ]);
      state.project = project.id;
    }
    await saveState(directory, state);
  }
  const projectFlags = ['--project', state.project!, '--environment', state.environment];
  if (!state.service) {
    const services = await run<{ id: string; name: string }[]>(['service', 'list', ...projectFlags, '--json']);
    const match = services.find((service) => service.name === slug);
    if (match) state.service = match.id;
    else {
      await run(['link', ...projectFlags, '--json']);
      const service = await run<{ id: string }>(['add', '--service', slug, '--json']);
      state.service = service.id;
    }
    await saveState(directory, state);
  }
  const flags = [...projectFlags, '--service', state.service!];
  const volumes = await run<{ volumes: { id: string; name: string; mountPath: string; serviceName: string }[] }>([
    'volume',
    ...flags,
    'list',
    '--json'
  ]);
  const attached = volumes.volumes.filter((volume) => volume.serviceName === slug);
  if (attached.length > 1) throw new Error('More than one volume is attached to the shard service.');
  let volume = attached[0];
  if (!volume) {
    const created = await run<{ id: string; name: string }>([
      'volume',
      ...flags,
      'add',
      '--mount-path',
      '/app/data',
      '--json'
    ]);
    volume = { ...created, mountPath: '/app/data', serviceName: slug };
  }
  if (state.volume && state.volume !== volume.id) {
    delete state.clientDigest;
    delete state.pendingClientDigest;
  }
  state.volume = volume.id;
  await saveState(directory, state);
  if (volume.name !== 'data' || volume.mountPath !== '/app/data') {
    for (let attempt = 0; ; attempt++) {
      try {
        await run([
          'volume',
          ...flags,
          'update',
          '--volume',
          volume.id,
          '--name',
          'data',
          '--mount-path',
          '/app/data',
          '--json'
        ]);
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await pause(3000);
      }
    }
  }
  const proxies = await run<{ proxies: { applicationPort: number }[] }>(['tcp-proxy', 'list', ...flags, '--json']);
  if (proxies.proxies.length && !proxies.proxies.some((proxy) => proxy.applicationPort === 2593)) {
    throw new Error('The existing TCP proxy points to another application port. It was not replaced.');
  }
  if (!proxies.proxies.length) await run(['tcp-proxy', 'create', ...flags, '--port', '2593', '--json']);
  await run([
    'variable',
    'set',
    ...flags,
    'RAILWAY_DOCKERFILE_PATH=Dockerfile',
    'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45',
    '--skip-deploys',
    '--json'
  ]);
  return state;
}
export async function ensureRailwayMysql(directory: string, state: RailwayState, run: RailwayCommand): Promise<void> {
  if (!state.project || !state.service) throw new Error('Provision the shard before adding MySQL.');
  const projectFlags = ['--project', state.project, '--environment', state.environment];
  const services = await run<{ id: string; name: string }[]>(['service', 'list', ...projectFlags, '--json']);
  if (!state.mysql) {
    if (services.some((service) => service.name.toLowerCase() === 'mysql'))
      throw new Error('An unrecorded MySQL service already exists. It was not reused or replaced.');
    await run(['link', ...projectFlags, '--service', state.service, '--json']);
    state.mysql = { name: 'MySQL', creating: true };
    await saveState(directory, state);
    const created = await run<{ serviceId: string; serviceName: string }>(['add', '--database', 'mysql', '--json']);
    if (!created.serviceId || !created.serviceName)
      throw new Error('MySQL creation returned no service ID. Rerun deploy to discover the created service.');
    state.mysql = { service: created.serviceId, name: created.serviceName };
    await saveState(directory, state);
  } else if (!state.mysql.service) {
    const matches = services.filter((service) => service.name === state.mysql!.name);
    if (!state.mysql.creating || matches.length !== 1)
      throw new Error(
        'Previous MySQL provisioning is incomplete. Inspect the Railway project before retrying; no duplicate was created.'
      );
    state.mysql = { service: matches[0]!.id, name: matches[0]!.name };
    await saveState(directory, state);
  } else {
    const recorded = services.find((service) => service.id === state.mysql!.service);
    if (!recorded) throw new Error('The recorded MySQL service is missing. It was not recreated automatically.');
    state.mysql.name = recorded.name;
    await saveState(directory, state);
  }
  const name = state.mysql.name;
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new Error(
      'MySQL service name must contain letters, numbers, underscores or hyphens for reference variables.'
    );
  const reference = (key: string) => '${{' + name + '.' + key + '}}';
  await run([
    'variable',
    'set',
    ...projectFlags,
    '--service',
    state.service,
    'MYSQLHOST=' + reference('RAILWAY_PRIVATE_DOMAIN'),
    'MYSQLPORT=3306',
    'MYSQLUSER=' + reference('MYSQLUSER'),
    'MYSQLPASSWORD=' + reference('MYSQLPASSWORD'),
    'MYSQLDATABASE=' + reference('MYSQLDATABASE'),
    '--skip-deploys',
    '--json'
  ]);
}

export async function deploy(options: { files?: string; client?: boolean }, directory = process.cwd()): Promise<void> {
  directory = resolve(directory);
  const config = await loadShard(directory);
  const sourcePath =
    options.files ?? (config.emulator === 'sphere-x' ? config.sphere : config[config.emulator])?.clientFiles;
  const clientPath = sourcePath ? resolve(directory, sourcePath) : undefined;
  const webClientPath = options.client ? clientPath : undefined;
  if (options.client && !webClientPath)
    throw new Error('Deploying the web client requires --files <path> or clientFiles in gemwright.json.');
  const webFiles = webClientPath ? await createManifest(webClientPath) : undefined;
  if (!(await isAvailable('railway')))
    throw new Error('Railway CLI is missing. Install it and log in before running gemwright deploy.');
  if (!(await isAvailable('git'))) throw new Error('Git is required to stage the recorded emulator source.');
  const run: RailwayCommand = async <T>(args: string[]) =>
    JSON.parse(await command(['railway', ...args], directory)) as T;
  try {
    await run(['whoami', '--json']);
  } catch {
    throw new Error('Railway is not logged in or cannot be reached. Run railway login and check your connection.');
  }
  const emulator = deployments[config.emulator];
  await emulator.validate(directory, config);
  const recorded = await readFile(join(directory, '.gemwright/railway.json'), 'utf8').then(
    (text) => JSON.parse(text) as RailwayState,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    }
  );
  if (recorded?.emulator && recorded.emulator !== config.emulator)
    throw new Error('The recorded Railway service belongs to another emulator. It was not changed.');
  console.log(`Staging ${emulator.label} ${config.source!.revision.slice(0, 12)}...`);
  const context = await emulator.stage(directory, config);
  const client = clientPath ? await emulator.packageFiles(directory, clientPath) : undefined;
  const state = await ensureRailway(directory, config.id, run);
  state.emulator = config.emulator;
  await saveState(directory, state);
  if (config.sphere?.mysql) {
    console.log('Provisioning MySQL and linking the shard through Railway private networking...');
    await ensureRailwayMysql(directory, state, run);
  }
  const flags = ['--project', state.project!, '--environment', state.environment, '--service', state.service!];
  await run(['variable', 'set', ...flags, `TZ=${config.timezone}`, '--skip-deploys', '--json']);
  console.log('Uploading build context to Railway...');
  const upload = await command(
    ['railway', 'up', context, '--path-as-root', '--no-gitignore', ...flags, '--detach', '--json'],
    directory
  );
  // Railway up emits JSON log lines rather than one JSON document.
  let deploymentId: string | undefined;
  for (const line of upload.split('\n')) {
    try {
      const value = JSON.parse(line);
      deploymentId = value.deploymentId ?? value.id ?? deploymentId;
    } catch {
      /* Progress text is not a deployment ID. */
    }
  }
  let active = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    const deployments = await run<{ id: string; status: string }[]>([
      'deployment',
      'list',
      ...flags,
      '--limit',
      '1',
      '--json'
    ]);
    const latest = deployments[0];
    if (latest && (!deploymentId || latest.id === deploymentId)) {
      if (latest.status === 'SUCCESS') {
        active = true;
        break;
      }
      if (['FAILED', 'CRASHED', 'REMOVED'].includes(latest.status))
        throw new Error(
          `Railway deployment ${latest.id} ${latest.status.toLowerCase()}. Inspect its build and deployment logs.`
        );
    }
    if (attempt % 6 === 0) console.log(`Waiting for Railway build: ${latest?.status ?? 'pending'}...`);
    await sleep(5000);
  }
  if (!active) throw new Error('Railway build is still pending. Resources are recorded; rerun deploy to resume.');
  if (client && state.clientDigest !== client.digest) {
    const volumeFlags = ['volume', ...flags, 'files', '--volume', state.volume!];
    const root = await run<{ files: { name: string }[] }>([...volumeFlags, 'list', '/', '--json']);
    const names = new Set(root.files.map((file) => file.name));
    const ready = names.has('.client-ready');
    if (state.clientDigest || (ready && state.pendingClientDigest !== client.digest)) {
      throw new Error('Different client files are already installed. They were not replaced automatically.');
    }
    if (state.pendingClientDigest && state.pendingClientDigest !== client.digest)
      throw new Error('An import of different client files is pending. Resume with the same files.');
    state.pendingClientDigest = client.digest;
    await saveState(directory, state);
    if (!ready && !names.has('client.tar.gz')) {
      console.log(`Uploading ${Math.round(client.bytes / 1024 / 1024)} MiB of client data to the volume...`);
      await run([...volumeFlags, 'upload', client.archive, '/client.tar.gz.uploading', '--overwrite', '--json']);
      await run([...volumeFlags, 'rename', '/client.tar.gz.uploading', '/client.tar.gz', '--json']);
    }
    state.clientDigest = client.digest;
    delete state.pendingClientDigest;
    await saveState(directory, state);
  }
  const proxies = await run<{ proxies: { endpoint: string }[] }>(['tcp-proxy', 'list', ...flags, '--json']);
  console.log(`Railway deployment active. Shard endpoint: ${proxies.proxies[0]?.endpoint ?? 'pending'}`);
  if (!client && !state.clientDigest)
    console.log('Waiting for client files. Rerun gemwright deploy --files <directory> to import them.');
  if (webClientPath) await deployClient(directory, webClientPath, webFiles);
}
