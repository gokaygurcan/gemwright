import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '@gemwright/server/config';

import * as prompts from '@clack/prompts';

import { deploymentOptions, validateRemotePath, validateSshDestination } from '../src/deploy-options';
import { Cancelled } from '../src/prompts';

const folders: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gemwright-deploy-prompts-'));
  folders.push(root);
  await writeFile(
    join(root, 'gemwright.json'),
    JSON.stringify({ ...createConfig({ client: { version: '7.0.45.1' }, name: 'Prompt test' }), ...extra })
  );
  mocks.push(
    spyOn(prompts, 'intro').mockImplementation(() => {}),
    spyOn(prompts, 'note').mockImplementation(() => {})
  );
  return root;
}

test('questionnaire gathers an SSH deployment without assuming a web domain', async () => {
  const root = await fixture();
  const select = spyOn(prompts, 'select').mockResolvedValueOnce('ssh');
  const text = spyOn(prompts, 'text')
    .mockResolvedValueOnce('my-vps')
    .mockResolvedValueOnce('gemwright/test')
    .mockResolvedValueOnce('203.0.113.1')
    .mockResolvedValueOnce('/game/files');
  const confirm = spyOn(prompts, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.push(select, text, confirm);
  const options = await deploymentOptions({}, root, true);
  expect(options).toMatchObject({
    ssh: 'my-vps',
    remotePath: 'gemwright/test',
    publicHost: '203.0.113.1',
    client: false,
    files: '/game/files'
  });
  expect(options.domain).toBeUndefined();
});

test('saved vps settings are not asked again, and the plan can still be cancelled', async () => {
  const root = await fixture({ vps: { publicHost: '203.0.113.1' } });
  const select = spyOn(prompts, 'select');
  const confirm = spyOn(prompts, 'confirm').mockResolvedValueOnce(false);
  mocks.push(select, confirm);
  await expect(deploymentOptions({ prepare: true, files: '/files', client: false }, root, true)).rejects.toBeInstanceOf(
    Cancelled
  );
  expect(select).not.toHaveBeenCalled();
});

test('a configured vps block deploys without flags, and flags override it', async () => {
  const vps = { ssh: 'my-vps', path: 'srv/shard', publicHost: '203.0.113.1' };
  const root = await fixture({ vps, servuo: { clientFiles: '/files', autoCreateAccounts: true, owner: 'admin' } });
  expect(await deploymentOptions({}, root, false)).toMatchObject({
    ssh: 'my-vps',
    remotePath: 'srv/shard',
    publicHost: '203.0.113.1',
    files: '/files'
  });
  expect(await deploymentOptions({ publicHost: 'login.example.com', ssh: 'other' }, root, false)).toMatchObject({
    publicHost: 'login.example.com',
    ssh: 'other'
  });
});

test('invalid SSH inputs are rejected', () => {
  for (const value of ['-oProxyCommand=id', 'host;id', 'user@host:/tmp', 'host\nfoo'])
    expect(() => validateSshDestination(value)).toThrow();
  for (const value of ['/', '..', '../world', 'x/../world', 'path;id', '~/shard'])
    expect(() => validateRemotePath(value)).toThrow();
  expect(() => validateSshDestination('my-vps')).not.toThrow();
  expect(() => validateRemotePath('/srv/gemwright/test')).not.toThrow();
});
