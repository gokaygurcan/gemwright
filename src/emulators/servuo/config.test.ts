import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { upstreamConfig } from '../../../tests/servuo/config-fixture';
import { createConfig } from '../../config';
import { generatedOwnerPassword, validateOwner, validateOwnerPassword } from '../accounts';
import { prepareServuoFiles } from './config';

const settings = { autoCreateAccounts: false, owner: 'admin' };

test('updates selected settings and preserves unrelated upstream content', () => {
  const files = prepareServuoFiles(
    upstreamConfig,
    createConfig({ name: "British's Realm", expansion: 'td' }),
    settings,
    'test-password'
  );
  expect(files['Config/Server.cfg']).toBe(
    upstreamConfig['Config/Server.cfg'].replace('Name=My Shard', "Name=British's Realm")
  );
  expect(files['Config/Expansion.cfg']).toContain('CurrentExpansion=UOTD');
  expect(files['Config/DataPath.cfg']).toContain('CustomPath=data/client');
  expect(files['Config/Accounts.cfg']).toContain('AutoCreateAccounts=False');
  expect(files['Config/AutoSave.cfg']).toBe(upstreamConfig['Config/AutoSave.cfg']);
  expect(upstreamConfig['Config/Expansion.cfg']).toContain('CurrentExpansion=EJ');
});

test('owner seed matches ServUO password hashing and contains no plaintext password', () => {
  const files = prepareServuoFiles(upstreamConfig, createConfig({}), settings, 'test-password');
  const digest = createHash('sha1')
    .update('admintest-password', 'ascii')
    .digest('hex')
    .toUpperCase()
    .match(/../g)!
    .join('-');
  expect(files['Saves/Accounts/accounts.xml']).toContain(`<newCryptPassword>${digest}</newCryptPassword>`);
  expect(files['Saves/Accounts/accounts.xml']).toContain('<username>admin</username>');
  expect(Object.values(files).join('')).not.toContain('test-password');
  expect(files['.gitignore']).toContain('Saves/');
});

test('rejects changed upstream config layouts instead of silently omitting answers', () => {
  expect(() =>
    prepareServuoFiles(
      { ...upstreamConfig, 'Config/Expansion.cfg': '# Changed upstream format\n' },
      createConfig({}),
      settings,
      'test-password'
    )
  ).toThrow('missing');
  expect(() =>
    prepareServuoFiles(
      { ...upstreamConfig, 'Config/Accounts.cfg': 'AutoCreateAccounts=True\nProtectPasswords=None\n' },
      createConfig({}),
      settings,
      'test-password'
    )
  ).toThrow('Unsupported upstream password protection');
});

test('validates owner credentials against the classic login field size', () => {
  expect(validateOwner('admin')).toBeUndefined();
  expect(validateOwner('a'.repeat(16))).toBeUndefined();
  for (const value of ['', '<admin>', 'a'.repeat(17), 'user name']) expect(validateOwner(value)).toBeDefined();
  expect(validateOwnerPassword('')).toBeUndefined();
  expect(validateOwnerPassword('sixteen-char-pwd')).toBeUndefined();
  for (const value of ['short', 'a'.repeat(17), 'password\n', 'pässword'])
    expect(validateOwnerPassword(value)).toBeDefined();
  expect(validateOwnerPassword('a'.repeat(16))).toBeUndefined();
  expect(generatedOwnerPassword()).toHaveLength(16);
});

test('ServUO writes shared contact answers to General.cfg and preserves other settings', () => {
  const files = prepareServuoFiles(
    upstreamConfig,
    createConfig({
      adminEmail: 'owner@example.org',
      url: 'https://example.org/help'
    }),
    settings,
    'test-password'
  );
  expect(files['Config/General.cfg']).toBe(
    '# Contact\nSupportEmail=owner@example.org\nSupportWebsite=https://example.org/help\n'
  );
  expect(() =>
    prepareServuoFiles(
      { ...upstreamConfig, 'Config/General.cfg': '' },
      createConfig({
        adminEmail: 'owner@example.org'
      }),
      settings,
      'test-password'
    )
  ).toThrow('missing');
});
