import { expect, test } from 'bun:test';

import { command } from '@gemwright/deployment/process';

import { dnsProblems, hostProblems, hostReportScript, parseHostReport, reachable } from '../src/vps-preflight';

const ready = { freeKib: 20 * 1024 * 1024, listening: [22], sudo: true, docker: true };
const options = { publicHost: '203.0.113.1' };

test('the host report script runs and parses on a real shell', async () => {
  const report = parseHostReport(await command(['sh', '-c', hostReportScript('/no/such/path')], '/'));
  expect(report.freeKib).toBeGreaterThan(0);
});

test('host problems name low disk, taken ports and unusable sudo', () => {
  expect(hostProblems(ready, options, false, false)).toEqual([]);
  expect(hostProblems({ ...ready, freeKib: 1024 }, options, false, false)[0]).toContain('10 GiB');
  const web = { ...options, client: true, domain: 'play.example.com' };
  expect(hostProblems({ ...ready, listening: [80, 2593] }, web, false, false)[0]).toContain('2593, 80');
  expect(hostProblems({ ...ready, listening: [80, 2593] }, web, true, false)).toEqual([]);
  const noDocker = { ...ready, sudo: false, docker: false };
  expect(hostProblems(noDocker, options, false, false)[0]).toContain('sudo');
  expect(hostProblems(noDocker, options, false, true)).toEqual([]);
  expect(hostProblems({ ...ready, sudo: false }, options, false, false)).toEqual([]);
});

test('an unresolved name stops the deployment; a different address only warns', async () => {
  const web = { publicHost: '203.0.113.1', client: true, domain: 'play.example.com' };
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  expect(await dnsProblems(web, async () => ['198.51.100.1'], warn)).toEqual([]);
  expect(warnings[0]).toContain('198.51.100.1');
  const failed = async () => Promise.reject(new Error('ENOTFOUND'));
  expect((await dnsProblems(web, failed, warn))[0]).toContain('play.example.com');
  expect((await dnsProblems({ publicHost: 'login.example.com' }, failed, warn))[0]).toContain('login.example.com');
});

test('a deployment is reachable only when its port answers from here', async () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    await expect(reachable('127.0.0.1', server.port, 1)).resolves.toBeUndefined();
  } finally {
    server.stop(true);
  }
  await expect(reachable('127.0.0.1', server.port, 1, 0)).rejects.toThrow('firewall');
});

test('small servers are warned about memory, never refused', () => {
  const warnings: string[] = [];
  expect(
    hostProblems({ ...ready, memoryKib: 1_960_000 }, options, false, false, (line) => warnings.push(line))
  ).toEqual([]);
  expect(warnings[0]).toContain('1914 MiB');
  warnings.length = 0;
  hostProblems({ ...ready, memoryKib: 4_000_000 }, options, false, false, (line) => warnings.push(line));
  expect(warnings).toEqual([]);
});
