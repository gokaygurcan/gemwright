import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { sphereFixture, sphereSettings } from '../../../tests/sphere/config-fixture';
import { createConfig, expansions } from '../../config';
import type { InstanceFiles } from '../../instance';
import {
  fetchSphereFiles,
  prepareSphereFiles,
  sphereMapCount,
  sphereTimezone,
  validateSphereName,
  validateSphereOwner
} from './config';
import { sphereSources } from './source';

function decoded(files: InstanceFiles, filename: string): string {
  const value = files[filename]!;
  return typeof value === 'string' ? value : Buffer.from(value).toString('latin1');
}

test('Sphere writes answers to ini and script includes while preserving unrelated bytes and defaults', () => {
  const upstream = sphereFixture();
  const config = createConfig({
    name: "British's Realm",
    emulator: 'sphere',
    expansion: 'tol',
    timezone: 'Europe/London'
  });
  const settings = { ...sphereSettings, maps: 'felucca' as const, autoCreateAccounts: true };
  const result = prepareSphereFiles(upstream, config, settings, 'sixteen-char-pwd');
  const ini = decoded(result, 'sphere.ini');
  expect(ini).toContain("ServName=British's Realm\r\n");
  expect(ini).toContain("[SERVERS]\r\nBritish's Realm\r\n127.0.0.1\r\n2593");
  expect(ini).toContain('AutoAccountCreation=1\r\n');
  expect(ini).toContain('Md5Passwords=1\r\n');
  expect(ini).toContain('MulFiles=data/client/\r\n');
  expect(ini).toContain('SavePeriod=20\r\n');
  expect(ini).toContain('ServIP=127.0.0.1\r\n');
  expect(ini).toContain('TimeZone=0\r\n');
  expect(ini).toContain('Map1=\r\n');
  const tables = decoded(result, 'scripts/spheretables.scp');
  expect(tables).toContain('\r\nscripts/maps/sphere_map0.scp\r\n');
  expect(tables).toContain('\r\n//scripts/maps/sphere_map1.scp\r\n');
  expect(tables).toContain('\r\n//scripts/maps/sphere_map_points5.scp\r\n');
  for (const filename of ['sphereCrypt.ini', 'scripts/sphere_defs.scp', 'scripts/adddialog.db'])
    expect(result[filename]).toEqual(upstream[filename]);
  expect(decoded(upstream, 'sphere.ini')).toContain('ServName=MyShard');
});

test('Sphere owner seed uses its native MD5 format and owner privilege without storing plaintext', () => {
  const password = 'safe-password-16';
  const files = prepareSphereFiles(sphereFixture(), createConfig({ emulator: 'sphere' }), sphereSettings, password);
  expect(files['accounts/sphereaccu.scp']).toBe(
    `[admin]\nPLEVEL=Owner\nMD5PASSWORD=${createHash('md5').update(password).digest('hex')}\n\n[EOF]\n`
  );
  expect(JSON.stringify(files)).not.toContain(password);
  expect(files['.gitignore']).toContain('accounts/\n');
});

test('Sphere applies cumulative client features and synchronizes map definitions and script includes for every expansion', () => {
  const counts = [1, 1, 2, 3, 3, 4, 5, 5, 6, 6, 6, 6];
  for (const [index, expansion] of expansions.entries()) {
    const files = prepareSphereFiles(
      sphereFixture(),
      createConfig({ emulator: 'sphere', expansion: expansion.value }),
      sphereSettings,
      'safe-password-16'
    );
    const ini = decoded(files, 'sphere.ini');
    expect(sphereMapCount(expansion.value)).toBe(counts[index]!);
    for (let map = 0; map < 6; map++) {
      expect(ini).toContain(
        `Map${map}=${map === 5 ? '1280,4096' : map < counts[index]! ? (map < 2 ? '7168,4096' : map === 2 ? '2304,1600' : map === 3 ? '2560,2048' : map === 4 ? '1448,1448' : '1280,4096') : '\r\n'}`
      );
      const entry = `${map < counts[index]! ? '' : '//'}scripts/maps/sphere_map${map}.scp\r\n`;
      expect(decoded(files, 'scripts/spheretables.scp')).toContain(`\r\n${entry}`);
    }
    expect(ini).toContain(`FeatureTOL=${index >= 10 ? '01' : '0'}\r\n`);
    expect(ini).toContain(`FeatureAOS=${index >= 5 ? '01|02|04|08' : '0'}\r\n`);
  }
});

test('Sphere supports legacy client terrain for older expansions and rejects incompatible or changed inputs', async () => {
  const config = createConfig({ emulator: 'sphere', expansion: 'uor' });
  const files = prepareSphereFiles(
    sphereFixture(),
    config,
    { ...sphereSettings, mapSize: 'legacy' },
    'safe-password-16'
  );
  expect(decoded(files, 'sphere.ini')).toContain('Map0=6144,4096,-1,0,0');
  expect(() =>
    prepareSphereFiles(
      sphereFixture(),
      createConfig({ emulator: 'sphere' }),
      { ...sphereSettings, mapSize: 'legacy' },
      'safe-password-16'
    )
  ).toThrow('require modern map files');
  const changed = sphereFixture();
  changed['sphere.ini'] = decoded(changed, 'sphere.ini').replace('Md5Passwords=0', 'RemovedPasswordSetting=0');
  expect(() => prepareSphereFiles(changed, config, sphereSettings, 'safe-password-16')).toThrow('Md5Passwords');
  const missing = sphereFixture();
  delete missing['scripts/maps/sphere_map1.scp'];
  expect(() => prepareSphereFiles(missing, config, sphereSettings, 'safe-password-16')).toThrow(
    'Missing upstream map script'
  );
  expect(() => prepareSphereFiles(sphereFixture(), config, sphereSettings, '')).toThrow('password');
  for (const owner of ['123', 'eof', 'ACCOUNT', 'update', 'addmd5']) expect(validateSphereOwner(owner)).toBeDefined();
  expect(validateSphereOwner('sphere_owner')).toBeUndefined();
  expect(validateSphereName('Good Shard')).toBeUndefined();
  expect(validateSphereName('Bad//Shard')).toBeDefined();
  expect(() =>
    prepareSphereFiles(
      sphereFixture(),
      createConfig({ emulator: 'sphere', name: '[SPHERE]' }),
      sphereSettings,
      'safe-password-16'
    )
  ).toThrow('Sphere names');
  await expect(
    fetchSphereFiles({ server: { ...sphereSources.server, revision: 'main' }, scripts: sphereSettings.scriptsSource })
  ).rejects.toThrow('Invalid Sphere server');
});

test('Sphere unloads newer map extensions for earlier expansions', () => {
  const upstream = sphereFixture();
  upstream['scripts/spheretables.scp'] += 'scripts/maps/sphere_map0_ml.scp\r\nscripts/maps/sphere_map0_sa.scp\r\n';
  upstream['scripts/maps/sphere_map0_ml.scp'] = '// fixture';
  upstream['scripts/maps/sphere_map0_sa.scp'] = '// fixture';
  const old = prepareSphereFiles(
    upstream,
    createConfig({ emulator: 'sphere', expansion: 'uor' }),
    { ...sphereSettings, mapSize: 'legacy' },
    'safe-password-16'
  );
  expect(decoded(old, 'scripts/spheretables.scp')).toContain('\r\n//scripts/maps/sphere_map0_ml.scp\r\n');
  expect(decoded(old, 'scripts/spheretables.scp')).toContain('\r\n//scripts/maps/sphere_map0_sa.scp\r\n');
  const modern = prepareSphereFiles(
    upstream,
    createConfig({ emulator: 'sphere', expansion: 'tol' }),
    sphereSettings,
    'safe-password-16'
  );
  expect(decoded(modern, 'scripts/spheretables.scp')).toContain('\r\nscripts/maps/sphere_map0_ml.scp\r\n');
});

test('Sphere writes client encryption answers at initialization and preserves old settings when unanswered', () => {
  for (const [mode, encrypted, plain] of [
    ['encrypted', '1', '0'],
    ['both', '1', '1'],
    ['unencrypted', '0', '1']
  ] as const) {
    const files = prepareSphereFiles(
      sphereFixture(),
      createConfig({ emulator: 'sphere' }),
      { ...sphereSettings, clientEncryption: mode },
      'Sphere-Password'
    );
    expect(decoded(files, 'sphere.ini')).toContain(`UseCrypt=${encrypted}\r\n`);
    expect(decoded(files, 'sphere.ini')).toContain(`UseNoCrypt=${plain}\r\n`);
  }
  const files = prepareSphereFiles(
    sphereFixture(),
    createConfig({ emulator: 'sphere' }),
    { ...sphereSettings, clientEncryption: undefined },
    'Sphere-Password'
  );
  expect(decoded(files, 'sphere.ini')).toContain('UseNoCrypt=0\r\n');
});

test('Sphere advertises standard whole hours west of GMT independently of DST and host timezone', () => {
  expect(sphereTimezone('Europe/Amsterdam', 2026)).toBe(-1);
  expect(sphereTimezone('Europe/London', 2026)).toBe(0);
  expect(sphereTimezone('America/New_York', 2026)).toBe(5);
  expect(sphereTimezone('Australia/Sydney', 2026)).toBe(-10);
  expect(() => sphereTimezone('Asia/Kolkata', 2026)).toThrow('fractional-hour');
  const files = prepareSphereFiles(
    sphereFixture(),
    createConfig({
      emulator: 'sphere',
      timezone: 'Europe/Amsterdam',
      adminEmail: 'owner@example.org',
      url: 'www.example.org/shard'
    }),
    sphereSettings,
    'safe-password-16'
  );
  const ini = decoded(files, 'sphere.ini');
  expect(ini).toContain('TimeZone=-1\r\n');
  expect(ini).toContain('AdminEmail=owner@example.org\r\n');
  expect(ini).toContain('URL=www.example.org/shard\r\n');
});
