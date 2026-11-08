import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { clientVersion, decisionProviders } from '@gemwright/common/config/shard';
import { aiSettings } from '@gemwright/deployment/ai-deploy';
import type { ShardConfig } from '@gemwright/server/config';

import type { LocalState } from './local-deploy';

// Healthy once the shard accepts connections; the first start compiles scripts for several minutes.
export const shardHealthcheck = {
  test: ['CMD', 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/2593'],
  interval: '10s',
  timeout: '5s',
  start_period: '15m',
  retries: 6
};

const composeLiteral = (value: string) => value.replaceAll('$', () => '$$');

// The project file describes every part deployed so far; a deploy rebuilds only the parts it names.
// On a VPS the world data stays in ./data, ports are public, and Caddy serves the client over HTTPS.
export function composeProject(config: ShardConfig, state: LocalState, vps?: { domain?: string }) {
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
      build: vps ? './shard' : './server',
      // Sphere 0.56 builds for x86-64 only; Docker emulates it on ARM machines.
      ...(config.emulator === 'sphere' ? { platform: 'linux/amd64' } : {}),
      restart: 'unless-stopped',
      stop_grace_period: '2m',
      ports: [vps ? '2593:2593/tcp' : `${bind}${state.serverPort ?? 2593}:2593/tcp`],
      environment,
      volumes: [vps ? './data:/app/data' : 'server-data:/app/data', './gamefiles:/app/data/client:ro'],
      healthcheck: shardHealthcheck,
      logging
    };
    if (!vps) volumes['server-data'] = {};
  }
  if (state.parts.includes('client'))
    compose.client = {
      build: vps ? './web' : './client',
      restart: 'unless-stopped',
      ...(vps ? {} : { ports: [`127.0.0.1:${state.clientPort ?? 3000}:3000/tcp`] }),
      environment: {
        UO_HOST: host,
        UO_PORT: port,
        ...(vps ? { PUBLIC_ORIGIN: `https://${vps.domain}` } : {}),
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
      volumes: ['ai-data:/app/data', './gamefiles:/app/data/assets:ro', './world:/app/data/world:ro'],
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
  if (vps && state.parts.includes('client')) {
    compose.caddy = {
      image: 'caddy:2.11-alpine',
      restart: 'unless-stopped',
      depends_on: { client: { condition: 'service_healthy' } },
      // The domain in Caddy's own settings: a new one makes Compose recreate it with the new Caddyfile.
      environment: { GEMWRIGHT_DOMAIN: vps.domain ?? '' },
      ports: ['80:80/tcp', '443:443/tcp', '443:443/udp'],
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config'],
      logging
    };
    volumes['caddy-data'] = {};
    volumes['caddy-config'] = {};
  }
  return { name: vps ? `gemwright-${config.id}` : `gemwright-${config.id}-local`, services: compose, volumes };
}

// Keys come from this environment when set; otherwise the ones saved earlier are kept.
export async function writeAiEnv(root: string, config: ShardConfig) {
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
