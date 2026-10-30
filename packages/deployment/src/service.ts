import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';

import type { RailwayCommand, RailwayState } from './deploy';

export interface ServiceState {
  project?: string;
  environment?: string;
  service?: string;
  name?: string;
  volume?: string;
  assets?: string;
  pendingAssets?: string;
  url?: string;
}
export async function readState<T>(path: string): Promise<T | undefined> {
  return readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as T,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    }
  );
}
export async function saveState(path: string, state: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function counterpart(directory: string, config: ShardConfig, run: RailwayCommand) {
  const recorded = await readState<RailwayState>(join(directory, '.gemwright/railway.json'));
  const project = config.railway?.project ?? recorded?.project;
  const environment = config.railway?.environment ?? recorded?.environment ?? 'production';
  if (!project)
    throw new Error('Set railway.project and railway.environment in gemwright.json, or deploy the server first.');
  if (recorded?.project && (recorded.project !== project || recorded.environment !== environment))
    throw new Error(
      'Configured Railway target differs from recorded resources. Use a separate shard directory for another target.'
    );
  const flags = ['--project', project, '--environment', environment];
  const services = await run<{ id: string; name: string }[]>(['service', 'list', ...flags, '--json']);
  const serverId = config.railway?.server ?? (config.connection ? undefined : recorded?.service);
  const matches = services.filter((entry) => entry.id === serverId || entry.name === serverId);
  if (serverId && matches.length !== 1)
    throw new Error('The configured/recorded server is missing or ambiguous; it was not replaced.');
  const server = matches[0];
  if (server && !/^[A-Za-z0-9_-]+$/.test(server.name))
    throw new Error('Server service name cannot be used in a Railway variable reference.');
  if (!server && !config.connection)
    throw new Error('Set an explicit connection.host and connection.port, or railway.server, in gemwright.json.');
  return {
    project,
    environment,
    flags,
    services,
    server,
    name: server?.name ?? config.id,
    host: config.connection?.host ?? `\${{${server?.name}.RAILWAY_PRIVATE_DOMAIN}}`,
    port: config.connection?.port ?? 2593,
    aiPatched: recorded?.aiPatched === true
  };
}
export function validateAiSettings(config: ShardConfig): void {
  if (config.emulator !== 'servuo') throw new Error('AI residents support ServUO shards only.');
  if (config.servuo?.autoCreateAccounts === false)
    throw new Error('AI requires server account creation. Configure the server separately before deploying AI.');
  if (config.ai?.speech === 'claude' && !process.env.ANTHROPIC_API_KEY)
    throw new Error('ai.speech is claude, but ANTHROPIC_API_KEY is not set in this environment.');
}
export async function checkAi(directory: string, config: ShardConfig, run: RailwayCommand) {
  validateAiSettings(config);
  const target = await counterpart(directory, config, run);
  if (!target.server) {
    if (!config.connection?.aiReady)
      throw new Error(
        'Confirm the external ServUO AI patch, account creation and trusted AI source separately; then set connection.aiReady: true.'
      );
    return target;
  }
  const variables = await run<Record<string, string>>([
    'variable',
    'list',
    ...target.flags,
    '--service',
    target.server.id,
    '--json'
  ]);
  const name = `${target.name}-ai`;
  const trusted = (variables.GEMWRIGHT_TRUSTED_HOSTS ?? '').split(/[\s,;]+/);
  if (!(target.aiPatched || variables.GEMWRIGHT_AI_PATCHED === '1') || !trusted.includes(`${name}.railway.internal`))
    throw new Error(
      `Server AI prerequisites are missing. Separately run gemwright deploy --server --ai, or install the ServUO AI patch and set GEMWRIGHT_AI_PATCHED=1 and GEMWRIGHT_TRUSTED_HOSTS=${name}.railway.internal on the server. AI deployment did not change the server.`
    );
  return target;
}
export async function ensureService(
  path: string,
  name: string,
  target: Awaited<ReturnType<typeof counterpart>>,
  run: RailwayCommand
) {
  const state = (await readState<ServiceState>(path)) ?? {};
  if (state.project && (state.project !== target.project || state.environment !== target.environment))
    throw new Error('Recorded service belongs to another Railway target. No resources changed.');
  if (state.service && !target.services.some((service) => service.id === state.service))
    throw new Error('The recorded service is missing. Inspect Railway before retrying; it was not recreated.');
  const matches = target.services.filter((service) => service.name === name);
  if (matches.length > 1) throw new Error('Multiple services match the intended name. No service was adopted.');
  if (!state.service) {
    const existing = matches[0];
    if (existing) state.service = existing.id;
    else {
      await run(['link', ...target.flags, '--json']);
      state.service = (await run<{ id: string }>(['add', '--service', name, '--json'])).id;
      if (!state.service)
        throw new Error('Railway returned no service ID. Rerun to discover the service before creating another.');
    }
  }
  state.project = target.project;
  state.environment = target.environment;
  state.name = target.services.find((service) => service.id === state.service)?.name ?? name;
  await saveState(path, state);
  const flags = [...target.flags, '--service', state.service];
  const { volumes } = await run<{ volumes: { id: string; serviceName: string; mountPath: string }[] }>([
    'volume',
    ...flags,
    'list',
    '--json'
  ]);
  const attached = volumes.filter((entry) => entry.serviceName === state.name);
  if (attached.length > 1 || (attached[0] && attached[0].mountPath !== '/app/data'))
    throw new Error('Existing service volumes do not match /app/data. They were not replaced.');
  const volume = attached[0];
  if (state.volume && state.volume !== volume?.id)
    throw new Error('The recorded persistent volume is missing or changed. It was not replaced.');
  if (!state.volume) {
    state.volume =
      volume?.id ?? (await run<{ id: string }>(['volume', ...flags, 'add', '--mount-path', '/app/data', '--json'])).id;
    if (!state.volume) throw new Error('Railway returned no volume ID. Inspect volumes before retrying.');
    delete state.assets;
    await saveState(path, state);
  }
  return { state, flags, save: () => saveState(path, state) };
}
