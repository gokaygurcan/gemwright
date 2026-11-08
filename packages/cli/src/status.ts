import { join } from 'node:path';

import { railway } from '@gemwright/deployment/providers/railway';
import { readJson } from '@gemwright/deployment/state';
import type { VpsRunner } from '@gemwright/deployment/target';

export type Part = 'server' | 'client' | 'ai';
export type State = 'running' | 'starting' | 'stopped' | 'failing' | 'missing';

export interface ComponentStatus {
  part: Part;
  state: State;
  detail: string;
}

export interface ComposeContainer {
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
  Status: string;
}

const severity: State[] = ['running', 'stopped', 'starting', 'missing', 'failing'];
const worst = (rows: ComponentStatus[]) =>
  rows.reduce((a, b) => (severity.indexOf(b.state) > severity.indexOf(a.state) ? b : a));

// A part may run as several services (the VPS client is the web relay and Caddy); the worst one counts.
export function composeStatus(
  parts: Part[],
  containers: ComposeContainer[],
  services: Partial<Record<Part, string[]>> = {}
): ComponentStatus[] {
  return parts.map((part) =>
    worst((services[part] ?? [part]).map((service) => containerStatus(part, service, containers)))
  );
}

function containerStatus(part: Part, service: string, containers: ComposeContainer[]): ComponentStatus {
  {
    const container = containers.find((entry) => entry.Service === service);
    if (!container) return { part, state: 'missing', detail: `no ${service} container` };
    const { State: state, Health: health, ExitCode: code, Status: detail } = container;
    if (state === 'running')
      return {
        part,
        state: health === 'unhealthy' ? 'failing' : health === 'starting' ? 'starting' : 'running',
        detail
      };
    if (state === 'exited' && code === 0) return { part, state: 'stopped', detail };
    return { part, state: state === 'created' ? 'stopped' : 'failing', detail };
  }
}

// The deployment's own record of its parts, then Compose's view of their containers.
export const vpsStatusScript = (root: string) => `set -eu
cd '${root.replaceAll("'", "'\\''")}'
cat state.json
echo
echo ---
if docker info >/dev/null 2>&1; then docker compose -f compose.json ps --all --format json; else sudo -n docker compose -f compose.json ps --all --format json; fi`;

export async function vpsStatus(
  selected: Part[],
  vps: VpsRunner,
  directory: string,
  run: (args: string[], directory: string) => Promise<string>
): Promise<ComponentStatus[]> {
  const output = await run(vps.shell(vpsStatusScript(vps.root)), directory);
  const [state = '', report = ''] = output.split('\n---\n');
  const recorded = JSON.parse(state);
  const deployed: Part[] = [
    'server',
    ...(recorded.client ? (['client'] as const) : []),
    ...(recorded.ai ? (['ai'] as const) : [])
  ];
  const parts = deployed.filter((part) => !selected.length || selected.includes(part));
  return composeStatus(parts, parseComposePs(report), { client: ['client', 'caddy'] });
}

const railwayStates: Record<string, State> = {
  SUCCESS: 'running',
  FAILED: 'failing',
  CRASHED: 'failing',
  SLEEPING: 'stopped',
  REMOVED: 'missing'
};

export function railwayState(part: Part, deployment?: { status: string; createdAt: string }): ComponentStatus {
  if (!deployment) return { part, state: 'missing', detail: 'no deployment' };
  return {
    part,
    state: railwayStates[deployment.status] ?? 'starting',
    detail: `${deployment.status} since ${deployment.createdAt}`
  };
}

const railwayFiles: Record<Part, string> = { server: 'railway', client: 'webclient', ai: 'ai' };

export async function railwayStatus(
  selected: Part[],
  directory: string,
  run: (args: string[], directory: string) => Promise<string> = railway
): Promise<ComponentStatus[]> {
  const rows: ComponentStatus[] = [];
  for (const part of ['server', 'client', 'ai'] as const) {
    const state = await readJson<{ project?: string; environment?: string; service?: string }>(
      join(directory, `.gemwright/${railwayFiles[part]}.json`)
    );
    if (!state?.project || !state.service || (selected.length && !selected.includes(part))) continue;
    const scope = [
      '--project',
      state.project,
      '--environment',
      state.environment ?? 'production',
      '--service',
      state.service
    ];
    const [latest] = JSON.parse(await run(['deployment', 'list', ...scope, '--limit', '1', '--json'], directory));
    rows.push(railwayState(part, latest));
  }
  return rows;
}

export function parseComposePs(output: string): ComposeContainer[] {
  const text = output.trim();
  if (!text) return [];
  // Compose prints one object per line; older releases print a single array.
  return text.startsWith('[') ? JSON.parse(text) : text.split('\n').map((line) => JSON.parse(line));
}

export function printStatus(target: string, rows: ComponentStatus[], print = console.log) {
  print(`Target: ${target}`);
  for (const row of rows) print(`  ${row.part.padEnd(8)}${row.state.padEnd(10)}${row.detail}`);
  if (!rows.length) print('  Nothing selected is deployed here.');
  return rows.some((row) => row.state === 'failing' || row.state === 'missing');
}
