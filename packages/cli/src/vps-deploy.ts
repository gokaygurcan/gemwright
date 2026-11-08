import { randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GameFile } from '@gemwright/client/files';
import { createManifest } from '@gemwright/deployment/client-files';
import type { ServerAdapter } from '@gemwright/deployment/deploy';
import { attachedCommand, command } from '@gemwright/deployment/process';
import { validateAiSettings } from '@gemwright/deployment/service';
import { worldFileNames } from '@gemwright/deployment/world-files';
import { loadShard, type ShardConfig } from '@gemwright/server/config';

import { shardWorldFiles, type WorldSource } from './ai-deploy';
import { stageImage } from './assets';
import { composeProject, writeAiEnv } from './compose';
import { deployments } from './deploy';
import { withServicePackages } from './service-packages';
import { preflight, reachable } from './vps-preflight';
import { localPrerequisites } from './vps-prerequisites';

export interface VpsOptions {
  files?: string;
  server?: boolean;
  client?: boolean;
  ai?: boolean;
  world?: WorldSource;
  aiPatched?: boolean;
  images?: Partial<Record<'client' | 'ai', string>>;
  publicHost?: string;
  domain?: string;
  prepare?: boolean;
  installDeps?: boolean;
}

export function validateVpsOptions(options: VpsOptions) {
  const hostname = (value: string) =>
    value.length <= 253 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (
    !options.publicHost ||
    (!hostname(options.publicHost) && isIP(options.publicHost) !== 4) ||
    isIP(options.publicHost) === 6
  )
    throw new Error('--public-host requires the VPS public IPv4 address or a hostname resolving to IPv4.');
  if (
    options.client &&
    (!options.domain || !hostname(options.domain) || !options.domain.includes('.') || isIP(options.domain))
  )
    throw new Error('--client requires --domain with a public DNS hostname for HTTPS.');
  if (options.domain && !options.client) throw new Error('--domain requires --client.');
}

interface VpsState {
  emulator: string;
  client: boolean;
  ai?: boolean;
  aiPatched?: boolean;
  domain?: string;
}

const exists = async (path: string) =>
  !!(await stat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }));

export async function addMysql(
  root: string,
  shard: Record<string, unknown>,
  services: Record<string, unknown>,
  volumes: Record<string, unknown>
) {
  const secrets = join(root, '.env');
  if (!(await exists(secrets)))
    await writeFile(
      secrets,
      `MYSQL_PASSWORD=${randomBytes(32).toString('hex')}\nMYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}\n`,
      { mode: 0o600, flag: 'wx' }
    );
  Object.assign(shard.environment as Record<string, string>, {
    MYSQLHOST: 'mysql',
    MYSQLPORT: '3306',
    MYSQLUSER: 'gemwright',
    MYSQLPASSWORD: '$' + '{MYSQL_PASSWORD:?Missing MYSQL_PASSWORD}',
    MYSQLDATABASE: 'gemwright'
  });
  shard.depends_on = { mysql: { condition: 'service_healthy' } };
  services.mysql = {
    image: 'mysql:8.4',
    restart: 'unless-stopped',
    stop_grace_period: '1m',
    environment: {
      MYSQL_DATABASE: 'gemwright',
      MYSQL_USER: 'gemwright',
      MYSQL_PASSWORD: '$' + '{MYSQL_PASSWORD:?Missing MYSQL_PASSWORD}',
      MYSQL_ROOT_PASSWORD: '$' + '{MYSQL_ROOT_PASSWORD:?Missing MYSQL_ROOT_PASSWORD}'
    },
    volumes: ['mysql-data:/var/lib/mysql'],
    healthcheck: {
      test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 --silent'],
      interval: '5s',
      timeout: '5s',
      retries: 30
    }
  };
  volumes['mysql-data'] = {};
}

// One folder of game files per deployment, mounted read-only into every service that reads them:
// the selected set only (executables and account files never enter it), copying just the files
// that are new or changed and removing those that left the selection.
export async function syncGameFiles(root: string, assets: string, include?: RegExp) {
  const files = (await createManifest(assets)).filter((file) => !include || include.test(file.path));
  const gamefiles = join(root, 'gamefiles');
  await mkdir(gamefiles, { recursive: true, mode: 0o755 });
  await chmod(gamefiles, 0o755);
  const recorded: GameFile[] = await readFile(join(gamefiles, 'manifest.json'), 'utf8').then(
    (text) => JSON.parse(text).files,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  );
  const wanted = new Set(files.map((file) => file.path));
  const removed = recorded.filter((file) => !wanted.has(file.path)).map((file) => file.path);
  for (const path of removed) await rm(join(gamefiles, path), { force: true });
  const known = new Map(recorded.map((file) => [file.path, file.sha256]));
  const copied: string[] = [];
  for (const file of files) {
    const target = join(gamefiles, file.path);
    if (known.get(file.path) === file.sha256 && (await exists(target))) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(join(assets, file.path), target);
    await chmod(target, 0o644);
    for (let parent = dirname(target); parent !== gamefiles; parent = dirname(parent)) await chmod(parent, 0o755);
    copied.push(file.path);
  }
  await writeFile(join(gamefiles, 'manifest.json'), `${JSON.stringify({ files })}\n`, { mode: 0o644 });
  await chmod(join(gamefiles, 'manifest.json'), 0o644);
  return { files, copied, removed };
}

// The world files AI residents learn the land from, mounted read-only into the AI service; a
// staging that fails the check leaves the current folder as it is.
export async function installWorldFiles(root: string, staged: string) {
  const names = await worldFileNames(staged);
  await rm(join(root, 'world.next'), { recursive: true, force: true });
  for (const name of names) {
    await mkdir(dirname(join(root, 'world.next', name)), { recursive: true });
    await copyFile(join(staged, name), join(root, 'world.next', name));
  }
  await rm(join(root, 'world'), { recursive: true, force: true });
  await rename(join(root, 'world.next'), join(root, 'world'));
  return names.length;
}

// State stays outside the replaceable build contexts so rebuilds cannot erase a live world.
export async function writeVpsBundle(
  directory: string,
  config: ShardConfig,
  options: VpsOptions,
  staged?: string,
  assets?: string,
  worldFiles?: string
) {
  validateVpsOptions(options);
  const root = join(directory, '.gemwright/vps');
  const statePath = join(root, 'state.json');
  const previous: VpsState | undefined = await readFile(statePath, 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (previous && previous.emulator !== config.emulator)
    throw new Error('The VPS bundle belongs to another emulator. Use a separate shard directory.');
  if (!staged && !previous) throw new Error('Deploy the server to this VPS first: gemwright shard deploy --server.');
  const withClient = !!options.client || !!previous?.client;
  const withAi = !!options.ai || !!previous?.ai;
  const aiPatched = staged ? !!options.aiPatched : !!previous?.aiPatched;
  if (options.ai && !aiPatched)
    throw new Error('The VPS server was built without the AI patch. Run gemwright shard deploy --server --ai.');
  const domain = options.domain ?? previous?.domain;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'data'), { recursive: true });
  if (staged) {
    await rm(join(root, 'shard.next'), { recursive: true, force: true });
    await cp(staged, join(root, 'shard.next'), { recursive: true });
    await rm(join(root, 'shard'), { recursive: true, force: true });
    await rename(join(root, 'shard.next'), join(root, 'shard'));
  }
  if (options.client && !assets) throw new Error('Web client assets are required.');
  // Every service shares the folder: the client's set when the client runs, else the server's.
  if (assets)
    await syncGameFiles(root, assets, withClient ? undefined : deployments[config.emulator].gameFiles.pattern);
  if (options.client) {
    await rm(join(root, 'web'), { recursive: true, force: true });
    await mkdir(join(root, 'web'));
    await stageImage('client', join(root, 'web'), ['Dockerfile', '.dockerignore'], options.images?.client);
    await writeFile(join(root, 'Caddyfile'), `${domain} {\n    reverse_proxy client:3000\n}\n`);
  }
  if (options.ai) {
    if (!worldFiles) throw new Error('AI world files are required.');
    await installWorldFiles(root, worldFiles);
    await rm(join(root, 'ai'), { recursive: true, force: true });
    await mkdir(join(root, 'ai'));
    await stageImage('ai', join(root, 'ai'), ['Dockerfile'], options.images?.ai);
    await writeAiEnv(root, config);
  }
  const compose = composeProject(
    config,
    {
      emulator: config.emulator,
      parts: ['server', ...(withClient ? (['client'] as const) : []), ...(withAi ? (['ai'] as const) : [])],
      publicHost: options.publicHost,
      aiPatched
    },
    { domain }
  );
  if (config.sphere?.mysql)
    await addMysql(root, compose.services.server as Record<string, unknown>, compose.services, compose.volumes);
  await writeFile(join(root, 'compose.json'), `${JSON.stringify(compose, null, 2)}\n`);
  await writeFile(
    `${statePath}.tmp`,
    `${JSON.stringify({ emulator: config.emulator, client: withClient, ai: withAi, aiPatched, ...(domain ? { domain } : {}) }, null, 2)}\n`
  );
  await rename(`${statePath}.tmp`, statePath);
  return root;
}

// The Compose services a deployment builds and restarts; the others keep running untouched.
export const composeServices = (options: VpsOptions, config: ShardConfig) => [
  ...(options.server !== false ? ['server', ...(config.sphere?.mysql ? ['mysql'] : [])] : []),
  ...(options.client ? ['client', 'caddy'] : []),
  ...(options.ai ? ['ai'] : [])
];

// Images are built on the deploying machine for the VPS's architecture and shipped, so the VPS never
// compiles; Compose names them after the project and service.
export function dockerPlatform(machine: string) {
  const platforms: Record<string, string> = {
    x86_64: 'linux/amd64',
    amd64: 'linux/amd64',
    aarch64: 'linux/arm64',
    arm64: 'linux/arm64'
  };
  const platform = platforms[machine.trim()];
  if (!platform) throw new Error(`Gemwright cannot build images for a ${machine.trim()} VPS.`);
  return platform;
}
export const builtServices = (services: string[]) =>
  services.filter((service) => ['server', 'client', 'ai'].includes(service));
export const builtImages = (config: ShardConfig, services: string[]) =>
  builtServices(services).map((service) => `gemwright-${config.id}-${service}`);

export function bundleInstructions(options: VpsOptions & { ssh?: string }) {
  if (options.ssh) return undefined;
  return 'Copy this entire directory (including hidden files) to the VPS, then run: docker compose -f compose.json up -d --build --wait --wait-timeout 900';
}

export async function deployVps(options: VpsOptions & { ssh?: string }, directory = process.cwd()) {
  validateVpsOptions(options);
  directory = resolve(directory);
  if (!options.prepare && process.platform !== 'linux')
    throw new Error('VPS deployment runs on Linux. Use --ssh to deploy remotely or --prepare to generate a bundle.');
  const config = await loadShard(directory);
  const source =
    options.files ?? (config.emulator === 'sphere-x' ? config.sphere : config[config.emulator])?.clientFiles;
  if (!source) throw new Error('VPS deployment requires --files <path> or clientFiles in gemwright.json.');
  const bundle = join(directory, '.gemwright/vps');
  if (!options.prepare) {
    await preflight(options, bundle, await exists(join(bundle, 'state.json')), (script) =>
      command(['sh', '-c', script], directory)
    );
  }
  const assets = resolve(directory, source);
  const previous: VpsState | undefined = await readFile(join(bundle, 'state.json'), 'utf8').then(
    JSON.parse,
    () => undefined
  );
  if (options.ai) validateAiSettings(config);
  const aiPatched = config.emulator === 'servuo' && (!!options.ai || !!previous?.aiPatched);
  const components = (['server', 'client', 'ai'] as const).filter((part) =>
    part === 'server' ? options.server !== false : !!options[part]
  );
  const root = await withServicePackages(config, components, async (paths) => {
    const adapters: Record<string, ServerAdapter> = paths.server
      ? (await import(pathToFileURL(join(paths.server, 'dist/staging.js')).href)).deployments
      : deployments;
    const emulator = adapters[config.emulator] as ServerAdapter;
    let staged: string | undefined;
    if (options.server !== false) {
      await emulator.validate(directory, config);
      console.log(`Staging ${emulator.label} for VPS deployment...`);
      staged = await emulator.stage(directory, config, { ai: aiPatched });
    }
    const world = options.ai ? await shardWorldFiles(directory, config, options.world) : undefined;
    try {
      return await writeVpsBundle(directory, config, { ...options, aiPatched, images: paths }, staged, assets, world);
    } finally {
      if (world) await rm(world, { recursive: true, force: true });
    }
  });
  console.log(`VPS bundle: ${root}`);
  if (options.prepare) {
    const instructions = bundleInstructions(options);
    if (instructions) console.log(instructions);
    return root;
  }
  const prerequisites = await localPrerequisites(options, root);
  await attachedCommand([...prerequisites.sudo, 'docker', 'compose', '-f', 'compose.json', 'config', '--quiet'], root);
  const containers = await command(
    [
      ...prerequisites.sudo,
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=gemwright-${config.id}`
    ],
    root
  );
  if (containers) {
    const states = JSON.parse(
      await command([...prerequisites.sudo, 'docker', 'inspect', ...containers.split(/\s+/)], root)
    );
    if (
      states.some(
        (state: { Config: { Labels: Record<string, string> } }) =>
          state.Config.Labels['com.docker.compose.project.working_dir'] !== root
      )
    )
      throw new Error('This Compose project belongs to another deployment directory.');
  }
  const docker = [...prerequisites.sudo, 'docker'];
  const services = composeServices(options, config);
  await attachedCommand([...docker, 'compose', '-f', 'compose.json', 'build', ...services], root);
  await attachedCommand(
    [
      ...docker,
      'compose',
      '-f',
      'compose.json',
      'up',
      '-d',
      '--no-deps',
      '--remove-orphans',
      '--wait',
      '--wait-timeout',
      '900',
      ...services
    ],
    root
  );
  await reachable(options.publicHost ?? '', 2593);
  console.log(`VPS containers started. Native client: ${options.publicHost}:2593`);
  if (options.client) console.log(`ClassicUO: https://${options.domain} (DNS must point to this VPS).`);
  return root;
}
