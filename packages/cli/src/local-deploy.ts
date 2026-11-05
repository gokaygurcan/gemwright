import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { clientVersion, decisionProviders } from '@gemwright/common/config/shard';
import { aiSettings, mapPattern } from '@gemwright/deployment/ai-deploy';
import { packageClientFiles } from '@gemwright/deployment/client-files';
import type { DeployParts, ServerAdapter } from '@gemwright/deployment/deploy';
import { attachedCommand, command } from '@gemwright/deployment/process';
import { validateAiSettings } from '@gemwright/deployment/service';
import { loadShard, type ShardConfig } from '@gemwright/server/config';

import { stageImage } from './assets';
import { deployments } from './deploy';
import { withServicePackages } from './service-packages';
import { addMysql, installGameFiles } from './vps-deploy';

type Part = 'server' | 'client' | 'ai';

export interface LocalState {
  emulator: string;
  parts: Part[];
  aiPatched?: boolean;
  publicHost?: string;
  serverPort?: number;
  clientPort?: number;
}

export const localRoot = (directory: string) => join(resolve(directory), '.gemwright/local');
export const localProject = (config: ShardConfig) => `gemwright-${config.id}-local`;

export async function readLocalState(directory: string): Promise<LocalState | undefined> {
  return readFile(join(localRoot(directory), 'state.json'), 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

export async function dockerCompose(directory: string) {
  if (!(await command(['docker', 'compose', 'version'], directory).then(Boolean, () => false)))
    throw new Error('Docker Compose is missing. Install Docker Desktop or Docker Engine with the Compose plugin.');
  if (!(await command(['docker', 'info'], directory).then(Boolean, () => false)))
    throw new Error('Docker is not running. Start Docker Desktop (or your Docker engine) and retry.');
}

const composeLiteral = (value: string) => value.replaceAll('$', () => '$$');

// The project file describes every part deployed so far; a deploy rebuilds only the parts it names.
export function localCompose(config: ShardConfig, state: LocalState) {
  const publicHost = state.publicHost ?? '127.0.0.1';
  const bind = publicHost === '127.0.0.1' ? '127.0.0.1:' : '';
  const host = state.parts.includes('server') ? 'server' : config.connection?.host;
  const port = String(state.parts.includes('server') ? 2593 : (config.connection?.port ?? 2593));
  const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
  const compose: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  if (state.parts.includes('server')) {
    const environment: Record<string, string> = {
      TZ: config.timezone,
      GEMWRIGHT_PUBLIC_HOST: publicHost,
      GEMWRIGHT_PUBLIC_PORT: String(state.serverPort ?? 2593)
    };
    if (state.aiPatched) Object.assign(environment, { GEMWRIGHT_AI_PATCHED: '1', GEMWRIGHT_TRUSTED_HOSTS: 'ai' });
    compose.server = {
      build: './server',
      // Sphere 0.56 builds for x86-64 only; Docker emulates it on ARM machines.
      ...(config.emulator === 'sphere' ? { platform: 'linux/amd64' } : {}),
      restart: 'unless-stopped',
      stop_grace_period: '2m',
      ports: [`${bind}${state.serverPort ?? 2593}:2593/tcp`],
      environment,
      volumes: ['server-data:/app/data'],
      healthcheck: {
        test: ['CMD', 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/2593'],
        interval: '10s',
        timeout: '5s',
        start_period: '15m',
        retries: 6
      },
      logging
    };
    volumes['server-data'] = {};
  }
  if (state.parts.includes('client'))
    compose.client = {
      build: './client',
      restart: 'unless-stopped',
      ports: [`127.0.0.1:${state.clientPort ?? 3000}:3000/tcp`],
      environment: {
        UO_HOST: host,
        UO_PORT: port,
        SERVER_NAME: composeLiteral(config.name),
        UO_CLIENT_VERSION: process.env.UO_CLIENT_VERSION ?? clientVersion(config),
        UO_ENCRYPTION: process.env.UO_ENCRYPTION ?? '0'
      },
      volumes: ['./gamefiles:/app/data/gamefiles:ro'],
      healthcheck: {
        test: [
          'CMD',
          'bun',
          '-e',
          "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        interval: '10s',
        timeout: '5s',
        retries: 12
      },
      logging
    };
  if (state.parts.includes('ai'))
    compose.ai = {
      build: './ai',
      restart: 'unless-stopped',
      stop_grace_period: '45s',
      environment: {
        UO_HOST: host,
        UO_PORT: port,
        GEMWRIGHT_SHARD: composeLiteral(JSON.stringify(aiSettings(config)))
      },
      env_file: ['./ai.env'],
      volumes: ['ai-data:/app/data'],
      healthcheck: {
        test: ['CMD', 'test', '-f', '/app/data/.ai-ready'],
        interval: '5s',
        timeout: '5s',
        start_period: '10m',
        retries: 12
      },
      logging
    };
  if (state.parts.includes('ai')) volumes['ai-data'] = {};
  return { name: localProject(config), services: compose, volumes };
}

// Keys come from this environment when set; otherwise the ones saved earlier are kept.
async function writeAiEnv(root: string, config: ShardConfig) {
  const path = join(root, 'ai.env');
  const saved = await readFile(path, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const values = Object.fromEntries(
    saved
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
  const keys = new Set(['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  for (const entry of decisionProviders(config.ai?.decisions))
    if (entry.provider !== 'local' && entry.credentialEnv) keys.add(entry.credentialEnv);
  for (const key of keys) if (process.env[key]) values[key] = process.env[key] as string;
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function replace(staged: string, target: string) {
  await rm(`${target}.next`, { recursive: true, force: true });
  await cp(staged, `${target}.next`, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(`${target}.next`, target);
}

export async function deployLocal(
  options: DeployParts & { publicHost?: string; serverPort?: number; clientPort?: number },
  directory = process.cwd()
) {
  directory = resolve(directory);
  const config = await loadShard(directory);
  const parts = (['server', 'client', 'ai'] as const).filter(
    (part) => options[part] || (part === 'server' && !options.client && !options.ai)
  );
  const source =
    options.files ?? (config.emulator === 'sphere-x' ? config.sphere : config[config.emulator])?.clientFiles;
  if (!source) throw new Error('Local deployment requires --files <path> or clientFiles in gemwright.json.');
  const assets = resolve(directory, source);
  const root = localRoot(directory);
  const previous = await readLocalState(directory);
  if (previous && previous.emulator !== config.emulator)
    throw new Error('The local deployment belongs to another emulator. Use a separate shard directory.');
  const state: LocalState = previous ?? { emulator: config.emulator, parts: [] };
  const server = parts.includes('server') || state.parts.includes('server');
  if (options.ai) {
    validateAiSettings(config);
    if (!parts.includes('server') && !state.aiPatched && (server || !config.connection?.aiReady))
      throw new Error(
        server
          ? 'The local server was built without the AI patch. Run gemwright deploy --local --server --ai.'
          : 'Confirm the external ServUO AI patch, account creation and trusted AI source separately; then set connection.aiReady: true.'
      );
  }
  if (!server && !config.connection?.host)
    throw new Error(
      'Deploy the local server first (gemwright deploy --local --server), or set connection.host and connection.port.'
    );
  await dockerCompose(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return withServicePackages(config, parts, async (paths) => {
    const uploads: { service: string; archive: string; digest: string; target: string; reset?: string }[] = [];
    if (parts.includes('server')) {
      const adapters: Record<string, ServerAdapter> = paths.server
        ? (await import(pathToFileURL(join(paths.server, 'dist/staging.js')).href)).deployments
        : deployments;
      const emulator = adapters[config.emulator] as ServerAdapter;
      await emulator.validate(directory, config);
      const aiPatch = config.emulator === 'servuo' && (!!options.ai || !!state.aiPatched);
      console.log(`Staging ${emulator.label} for local deployment...`);
      const staged = await emulator.stage(directory, config, { ai: aiPatch });
      const client = await emulator.packageFiles(directory, assets);
      // A different game file set replaces the server's copy; the start script extracts it on boot.
      uploads.push({
        service: 'server',
        archive: client.archive,
        digest: client.digest,
        target: 'client.tar.gz',
        reset: 'rm -rf /app/data/client /app/data/.client-ready'
      });
      await replace(staged, join(root, 'server'));
      state.aiPatched = aiPatch;
    }
    if (parts.includes('client')) {
      await installGameFiles(root, assets, state.parts.includes('client'), true);
      await rm(join(root, 'client'), { recursive: true, force: true });
      await mkdir(join(root, 'client'));
      await stageImage('client', join(root, 'client'), ['Dockerfile', '.dockerignore'], paths.client);
    }
    if (parts.includes('ai')) {
      const maps = await packageClientFiles(directory, assets, mapPattern, (names) => {
        if (!names.includes('tiledata.mul') || !names.some((n) => n.startsWith('map1')))
          throw new Error('AI residents need tiledata.mul and the Trammel map (map1LegacyMUL.uop or map1.mul).');
      });
      await rm(join(root, 'ai'), { recursive: true, force: true });
      await mkdir(join(root, 'ai'));
      await stageImage('ai', join(root, 'ai'), ['Dockerfile'], paths.ai);
      uploads.push({ service: 'ai', archive: maps.archive, digest: maps.digest, target: 'assets.tar.gz' });
      await writeAiEnv(root, config);
    }
    state.parts = (['server', 'client', 'ai'] as const).filter(
      (part) => parts.includes(part) || state.parts.includes(part)
    );
    if (options.publicHost) state.publicHost = options.publicHost;
    if (options.serverPort) state.serverPort = options.serverPort;
    if (options.clientPort) state.clientPort = options.clientPort;
    const compose = localCompose(config, state);
    if (config.sphere?.mysql && compose.services.server)
      await addMysql(root, compose.services.server as Record<string, unknown>, compose.services, compose.volumes);
    await writeFile(join(root, 'compose.json'), `${JSON.stringify(compose, null, 2)}\n`);
    await attachedCommand(['docker', 'compose', '-f', 'compose.json', 'config', '--quiet'], root);
    const containers = await command(
      ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${localProject(config)}`],
      root
    );
    if (containers) {
      const inspected = JSON.parse(await command(['docker', 'inspect', ...containers.split(/\s+/)], root));
      if (
        inspected.some(
          (container: { Config: { Labels: Record<string, string> } }) =>
            container.Config.Labels['com.docker.compose.project.working_dir'] !== root
        )
      )
        throw new Error('This Compose project belongs to another deployment directory.');
    }
    if (config.sphere?.mysql && parts.includes('server'))
      await attachedCommand(['docker', 'compose', '-f', 'compose.json', 'up', '-d', '--wait', 'mysql'], root);
    const names = [...parts];
    await attachedCommand(['docker', 'compose', '-f', 'compose.json', 'build', ...names], root);
    // Files reach the data volumes through a one-off container, before the service starts. Each
    // volume records the set it holds, so a recreated or emptied volume gets the files again.
    for (const upload of uploads)
      await attachedCommand(
        [
          'docker',
          'compose',
          '-f',
          'compose.json',
          'run',
          '--rm',
          '--no-deps',
          '-T',
          '--entrypoint',
          'sh',
          '-v',
          `${upload.archive}:/upload:ro`,
          upload.service,
          '-c',
          `if [ "$(cat /app/data/.${upload.target}.digest 2>/dev/null)" != ${upload.digest} ]; then ${upload.reset ? `${upload.reset} && ` : ''}cp /upload /app/data/${upload.target}.tmp && mv /app/data/${upload.target}.tmp /app/data/${upload.target} && echo ${upload.digest} > /app/data/.${upload.target}.digest; fi`
        ],
        root
      );
    await attachedCommand(
      [
        'docker',
        'compose',
        '-f',
        'compose.json',
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        '--wait-timeout',
        '900',
        ...names
      ],
      root
    );
    await writeFile(join(root, 'state.json.tmp'), `${JSON.stringify(state, null, 2)}\n`);
    await rename(join(root, 'state.json.tmp'), join(root, 'state.json'));
    if (parts.includes('server'))
      console.log(`Local shard running. Native client: ${state.publicHost ?? '127.0.0.1'}:${state.serverPort ?? 2593}`);
    if (parts.includes('client')) console.log(`ClassicUO: http://localhost:${state.clientPort ?? 3000}`);
    if (parts.includes('ai')) console.log(`AI residents running: ${config.ai?.population ?? 10} residents.`);
    return root;
  });
}
