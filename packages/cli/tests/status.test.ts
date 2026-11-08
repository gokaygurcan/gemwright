import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeStatus, parseComposePs, printStatus, railwayState, railwayStatus, vpsStatus } from '../src/status';

const container = (Service: string, State: string, Health = '', ExitCode = 0) => ({
  Service,
  State,
  Health,
  ExitCode,
  Status: `${State} detail`
});

test('Compose containers map to component states with their reason', () => {
  const rows = composeStatus(
    ['server', 'client', 'ai'],
    [container('server', 'running', 'healthy'), container('client', 'exited', '', 137)]
  );
  expect(rows.map((row) => row.state)).toEqual(['running', 'failing', 'missing']);
  expect(rows[1]?.detail).toBe('exited detail');
  const states = composeStatus(
    ['server', 'client', 'ai'],
    [container('server', 'running', 'starting'), container('client', 'running', 'unhealthy'), container('ai', 'exited')]
  ).map((row) => row.state);
  expect(states).toEqual(['starting', 'failing', 'stopped']);
});

test('both Compose output shapes parse, and failures are reported', () => {
  const line = JSON.stringify(container('server', 'running'));
  expect(parseComposePs(`${line}\n${line}`)).toHaveLength(2);
  expect(parseComposePs(`[${line}]`)).toHaveLength(1);
  expect(parseComposePs('')).toEqual([]);
  const printed: string[] = [];
  expect(printStatus('local', composeStatus(['server'], []), (line) => printed.push(line))).toBe(true);
  expect(printed).toEqual(['Target: local', '  server  missing   no server container']);
  expect(printStatus('local', composeStatus(['server'], [container('server', 'exited')]), () => {})).toBe(false);
});

test('Railway deployments map to component states, and unknown statuses are shown as starting', async () => {
  const at = '2026-11-07T10:00:00Z';
  expect(railwayState('server', { status: 'SUCCESS', createdAt: at })).toEqual({
    part: 'server',
    state: 'running',
    detail: `SUCCESS since ${at}`
  });
  expect(railwayState('ai', { status: 'CRASHED', createdAt: at }).state).toBe('failing');
  expect(railwayState('ai', { status: 'BUILDING', createdAt: at }).state).toBe('starting');
  expect(railwayState('client').state).toBe('missing');
});

test('Railway status asks each recorded service, and only the selected ones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-status-'));
  try {
    await mkdir(join(directory, '.gemwright'));
    const state = { project: 'p', environment: 'production' };
    await writeFile(join(directory, '.gemwright/railway.json'), JSON.stringify({ ...state, service: 'shard' }));
    await writeFile(join(directory, '.gemwright/ai.json'), JSON.stringify({ ...state, service: 'shard-ai' }));
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify(args.includes('shard-ai') ? [] : [{ status: 'SUCCESS', createdAt: 'then' }]);
    };
    expect((await railwayStatus([], directory, run)).map((row) => row.state)).toEqual(['running', 'missing']);
    expect(calls[0]).toEqual([
      'deployment',
      'list',
      '--project',
      'p',
      '--environment',
      'production',
      '--service',
      'shard',
      '--limit',
      '1',
      '--json'
    ]);
    calls.length = 0;
    await railwayStatus(['ai'], directory, run);
    expect(calls).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('VPS Docker status maps shard, web and Caddy to their components', async () => {
  const containers = [container('server', 'running', 'healthy'), container('client', 'running', 'healthy')];
  const output = `${JSON.stringify({ client: true })}\n---\n${containers.map((c) => JSON.stringify(c)).join('\n')}`;
  const vps = { root: 'srv/shard', shell: (script: string) => ['ssh', 'my-vps', script] };
  const rows = await vpsStatus([], { ...vps, compose: () => '' }, '/', async () => output);
  expect(rows.map((row) => [row.part, row.state])).toEqual([
    ['server', 'running'],
    ['client', 'missing']
  ]);
  expect(rows[1]?.detail).toBe('no caddy container');
});
