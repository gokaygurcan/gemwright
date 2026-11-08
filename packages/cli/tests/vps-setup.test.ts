import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '@gemwright/deployment/process';
import { createConfig } from '@gemwright/server/config';

import { inspectionScript, parseInspection, recordServer, setupSteps } from '../src/vps-setup';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const ready = { user: 'deploy', ubuntu: true, compose: true, access: true };

test('the inspection script runs and parses on a real shell', async () => {
  const report = parseInspection(await command(['sh', '-c', inspectionScript], '/'));
  expect(report.user).toBeTruthy();
});

test('setup does only what is missing and always keeps the SSH port open', () => {
  const firewall = setupSteps(ready, { port: 2222 });
  expect(firewall.map((step) => step.label)).toEqual([expect.stringContaining('firewall')]);
  expect(firewall[0]?.script).toContain('ufw allow 2222/tcp');
  expect(firewall[0]?.script).toContain('ufw allow 2593/tcp');
  expect(firewall[0]?.script).not.toContain('443');
  expect(setupSteps(ready, { port: 22, client: true })[0]?.script).toContain('ufw allow 443/tcp');
  const fresh = setupSteps({ ...ready, compose: false, access: false }, { port: 22 });
  expect(fresh[0]?.script).toContain('docker-compose-v2');
  expect(fresh[1]?.script).toContain("usermod -aG docker 'deploy'");
  expect(fresh[1]?.label).toContain('root');
});

test('a root login gets a non-root deploy user with its SSH keys', () => {
  const steps = setupSteps({ ...ready, user: 'root', compose: false, access: true }, { port: 22 });
  expect(steps[0]?.script).toContain('useradd');
  expect(steps[0]?.script).toContain('authorized_keys');
  expect(steps.some((step) => step.script.includes("usermod -aG docker 'gemwright'"))).toBe(true);
  expect(steps.some((step) => step.script.includes('sudo'))).toBe(false);
});

test('setup refuses automatic changes outside Ubuntu', () => {
  expect(() => setupSteps({ ...ready, ubuntu: false, compose: false }, { port: 22 })).toThrow('Ubuntu');
  expect(setupSteps({ ...ready, ubuntu: false }, { port: 22 })).toHaveLength(1);
});

test('the vps block is recorded without disturbing other settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-setup-'));
  folders.push(directory);
  const path = join(directory, 'gemwright.json');
  const shard = {
    ...createConfig({ client: { version: '7.0.45.1' } }),
    vps: { publicHost: '203.0.113.9', domain: 'play.example.com' }
  };
  await writeFile(path, JSON.stringify(shard));
  await recordServer(directory, { ssh: 'deploy@203.0.113.1', port: 2222, publicHost: '203.0.113.1' });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.vps).toEqual({
    ssh: 'deploy@203.0.113.1',
    port: 2222,
    publicHost: '203.0.113.1',
    domain: 'play.example.com'
  });
  expect(saved.client).toEqual(shard.client);
});

test('small servers without swap get a swap file, others are left alone', () => {
  const small = { ...ready, memoryKib: 1_960_000, swapKib: 0 };
  const swap = setupSteps(small, { port: 22 }).find((step) => step.label.includes('swap'));
  expect(swap?.label).toContain('1914 MiB');
  expect(swap?.script).toContain('mkswap /swapfile');
  expect(swap?.script).toContain('/etc/fstab');
  expect(setupSteps({ ...small, swapKib: 2_097_148 }, { port: 22 }).some((step) => step.label.includes('swap'))).toBe(
    false
  );
  expect(setupSteps({ ...small, memoryKib: 8_000_000 }, { port: 22 }).some((step) => step.label.includes('swap'))).toBe(
    false
  );
});
