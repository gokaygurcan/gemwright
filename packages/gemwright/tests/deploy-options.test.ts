import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as prompts from '@clack/prompts';

import { createConfig } from '../src/config';
import { deploymentOptions, validateRemotePath, validateSshDestination } from '../src/deploy-options';
import { Cancelled } from '../src/prompts';

const folders: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gemwright-deploy-prompts-'));
  folders.push(root);
  await writeFile(join(root, 'gemwright.json'), JSON.stringify(createConfig({ name: 'Prompt test' })));
  mocks.push(
    spyOn(prompts, 'intro').mockImplementation(() => {}),
    spyOn(prompts, 'note').mockImplementation(() => {})
  );
  return root;
}

test('questionnaire gathers native SSH deployment without assuming a runtime or web domain', async () => {
  const root = await fixture();
  const select = spyOn(prompts, 'select')
    .mockResolvedValueOnce('vps')
    .mockResolvedValueOnce('native')
    .mockResolvedValueOnce('ssh');
  const text = spyOn(prompts, 'text')
    .mockResolvedValueOnce('hz')
    .mockResolvedValueOnce('gemwright/test')
    .mockResolvedValueOnce('203.0.113.1')
    .mockResolvedValueOnce('/game/files');
  const confirm = spyOn(prompts, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.push(select, text, confirm);
  const options = await deploymentOptions({}, root, true);
  expect(options).toMatchObject({
    target: 'vps',
    method: 'native',
    ssh: 'hz',
    remotePath: 'gemwright/test',
    publicHost: '203.0.113.1',
    client: false,
    files: '/game/files'
  });
  expect(options.domain).toBeUndefined();
  expect(select.mock.calls[1]?.[0].options.map((option) => option.value)).toEqual(['docker', 'native']);
});

test('manual questionnaire uses saved defaults and allows cancelling before deployment', async () => {
  const root = await fixture();
  await mkdir(join(root, '.gemwright'));
  await writeFile(join(root, '.gemwright/deployment.json'), JSON.stringify({ method: 'native' }));
  const select = spyOn(prompts, 'select').mockResolvedValueOnce('docker');
  const confirm = spyOn(prompts, 'confirm').mockResolvedValueOnce(false);
  mocks.push(select, confirm);
  await expect(
    deploymentOptions(
      { target: 'vps', prepare: true, publicHost: '203.0.113.1', files: '/files', client: false },
      root,
      true
    )
  ).rejects.toBeInstanceOf(Cancelled);
  expect(select.mock.calls[0]?.[0].initialValue).toBe('native');
});

test('noninteractive flags preserve Railway default and reject invalid SSH inputs', async () => {
  expect((await deploymentOptions({}, '/unused', false)).target).toBe('railway');
  await expect(deploymentOptions({ method: 'native' }, '/unused', false)).rejects.toThrow('require --target vps');
  for (const value of ['-oProxyCommand=id', 'host;id', 'user@host:/tmp', 'host\nfoo'])
    expect(() => validateSshDestination(value)).toThrow();
  for (const value of ['/', '..', '../world', 'x/../world', 'path;id', '~/shard'])
    expect(() => validateRemotePath(value)).toThrow();
  expect(() => validateSshDestination('hz')).not.toThrow();
  expect(() => validateRemotePath('/srv/gemwright/test')).not.toThrow();
});
