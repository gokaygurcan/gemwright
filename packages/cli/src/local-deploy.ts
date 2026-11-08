import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mapPattern } from '@gemwright/deployment/ai-deploy';
import type { DeployParts, ServerAdapter } from '@gemwright/deployment/deploy';
import { attachedCommand, command } from '@gemwright/deployment/process';
import { validateAiSettings } from '@gemwright/deployment/service';
import { loadShard, type ShardConfig } from '@gemwright/server/config';

import { shardWorldFiles, type WorldSource } from './ai-deploy';
import { stageImage } from './assets';
import { composeProject, writeAiEnv } from './compose';
import { deployments } from './deploy';
import { withServicePackages } from './service-packages';
import { addMysql, installWorldFiles, syncGameFiles } from './vps-deploy';

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

async function replace(staged: string, target: string) {
  await rm(`${target}.next`, { recursive: true, force: true });
  await cp(staged, `${target}.next`, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(`${target}.next`, target);
}

export async function deployLocal(
  options: DeployParts & { publicHost?: string; serverPort?: number; clientPort?: number; world?: WorldSource },
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
          ? 'The local server was built without the AI patch. Run gemwright shard deploy --target local --server --ai.'
          : 'Confirm the external ServUO AI patch, account creation and trusted AI source separately; then set connection.aiReady: true.'
      );
  }
  if (!server && !config.connection?.host)
    throw new Error(
      'Deploy the local server first (gemwright shard deploy --target local --server), or set connection.host and connection.port.'
    );
  await dockerCompose(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return withServicePackages(config, parts, async (paths) => {
    const adapters: Record<string, ServerAdapter> = paths.server
      ? (await import(pathToFileURL(join(paths.server, 'dist/staging.js')).href)).deployments
      : deployments;
    const emulator = adapters[config.emulator] as ServerAdapter;
    const { gameFiles } = emulator;
    const fileNames = (await readdir(assets)).map((name) => name.toLowerCase());
    if (parts.includes('server')) {
      await gameFiles.check(directory, fileNames);
      await emulator.validate(directory, config);
      const aiPatch = config.emulator === 'servuo' && (!!options.ai || !!state.aiPatched);
      console.log(`Staging ${emulator.label} for local deployment...`);
      const staged = await emulator.stage(directory, config, { ai: aiPatch });
      await replace(staged, join(root, 'server'));
      state.aiPatched = aiPatch;
    }
    if (parts.includes('client')) {
      await rm(join(root, 'client'), { recursive: true, force: true });
      await mkdir(join(root, 'client'));
      await stageImage('client', join(root, 'client'), ['Dockerfile', '.dockerignore'], paths.client);
    }
    if (parts.includes('ai')) {
      if (!fileNames.includes('tiledata.mul') || !fileNames.some((name) => /^map1(?:\.mul|legacymul\.uop)$/.test(name)))
        throw new Error('AI residents need tiledata.mul and the Trammel map (map1LegacyMUL.uop or map1.mul).');
      const world = await shardWorldFiles(directory, config, options.world);
      try {
        await installWorldFiles(root, world);
      } finally {
        await rm(world, { recursive: true, force: true });
      }
      await rm(join(root, 'ai'), { recursive: true, force: true });
      await mkdir(join(root, 'ai'));
      await stageImage('ai', join(root, 'ai'), ['Dockerfile'], paths.ai);
      await writeAiEnv(root, config);
    }
    state.parts = (['server', 'client', 'ai'] as const).filter(
      (part) => parts.includes(part) || state.parts.includes(part)
    );
    if (options.publicHost) state.publicHost = options.publicHost;
    if (options.serverPort) state.serverPort = options.serverPort;
    if (options.clientPort) state.clientPort = options.clientPort;
    // Every service mounts this one folder: the client's set when the client runs, else the server's
    // set, else the maps the AI walks by.
    await syncGameFiles(
      root,
      assets,
      state.parts.includes('client') ? undefined : state.parts.includes('server') ? gameFiles.pattern : mapPattern
    );
    const compose = composeProject(config, state);
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
