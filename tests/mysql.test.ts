import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '../src/config';
import { ensureRailwayMysql, type RailwayCommand, type RailwayState } from '../src/deploy';
import { prepareSphereFiles, sphereConfigValue } from '../src/emulators/sphere/config';
import { initializeSphere } from '../src/emulators/sphere/init';
import { sphereSources } from '../src/emulators/sphere/source';
import { sphereFixture, sphereSettings } from './sphere/config-fixture';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'gemwright-mysql-'));
  directories.push(path);
  return path;
}
const state = (): RailwayState => ({
  projectName: 'test',
  project: 'project',
  service: 'shard',
  environment: 'production'
});

test('MySQL is opt-in and generated Sphere files contain no database credentials', async () => {
  const pair = { server: { ...sphereSources.server, revision: 'a'.repeat(40) }, scripts: sphereSettings.scriptsSource };
  const config = createConfig({ emulator: 'sphere', source: pair.server });
  const normal = await initializeSphere(config, pair, true, async () => sphereFixture());
  expect(normal.settings.mysql).toBeUndefined();
  const mysql = await initializeSphere(config, pair, true, async () => sphereFixture(), true);
  expect(mysql.settings.mysql).toBe(true);
  const ini = Buffer.from(mysql.files['sphere.ini']!).toString('latin1');
  expect(sphereConfigValue(ini, 'MySQL')).toBe('1');
  for (const key of ['MySQLHost', 'MySQLUser', 'MySQLPassword', 'MySQLDatabase'])
    expect(sphereConfigValue(ini, key)).toBeUndefined();
  expect(() => createConfig({ ...config, sphere: { ...sphereSettings, mysql: 'yes' as unknown as boolean } })).toThrow(
    'Invalid Sphere settings'
  );
  const plain = prepareSphereFiles(sphereFixture(), config, sphereSettings, 'test-password');
  expect(sphereConfigValue(Buffer.from(plain['sphere.ini']!).toString(), 'MySQL')).toBe('0');
});

test('MySQL provisioning creates one service, stores only identifiers, and uses private reference variables', async () => {
  const path = await directory();
  const saved = state();
  const calls: string[][] = [];
  let created = false;
  const run: RailwayCommand = async <T>(args: string[]) => {
    calls.push(args);
    if (args[0] === 'service') return (created ? [{ id: 'database', name: 'MySQL' }] : []) as T;
    if (args[0] === 'add') {
      created = true;
      return { serviceId: 'database', serviceName: 'MySQL' } as T;
    }
    return {} as T;
  };
  await ensureRailwayMysql(path, saved, run);
  await ensureRailwayMysql(path, saved, run);
  expect(calls.filter((args) => args[0] === 'add')).toEqual([['add', '--database', 'mysql', '--json']]);
  const vars = calls.find((args) => args[0] === 'variable')!;
  expect(vars).toContain('MYSQLHOST=${{MySQL.RAILWAY_PRIVATE_DOMAIN}}');
  expect(vars).toContain('MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}');
  expect(vars).toContain('MYSQLPORT=3306');
  expect(vars).toContain('--skip-deploys');
  expect(JSON.parse(await readFile(join(path, '.gemwright/railway.json'), 'utf8')).mysql).toEqual({
    service: 'database',
    name: 'MySQL'
  });
  expect(await readFile(join(path, '.gemwright/railway.json'), 'utf8')).not.toContain('MYSQLPASSWORD');
});

test('MySQL creation recovers after an interrupted response without creating a duplicate', async () => {
  const path = await directory();
  const saved = state();
  let created = false,
    adds = 0;
  const run: RailwayCommand = async <T>(args: string[]) => {
    if (args[0] === 'service') return (created ? [{ id: 'database', name: 'MySQL' }] : []) as T;
    if (args[0] === 'add') {
      adds++;
      created = true;
      throw new Error('Connection lost');
    }
    return {} as T;
  };
  await expect(ensureRailwayMysql(path, saved, run)).rejects.toThrow('Connection lost');
  const recovered: RailwayState = JSON.parse(await readFile(join(path, '.gemwright/railway.json'), 'utf8'));
  await ensureRailwayMysql(path, recovered, run);
  expect(adds).toBe(1);
  expect(recovered.mysql).toEqual({ service: 'database', name: 'MySQL' });
});

test('MySQL provisioning refuses unrelated or missing services rather than replacing data', async () => {
  const path = await directory();
  const calls: string[][] = [];
  const existing: RailwayCommand = async <T>(args: string[]) => {
    calls.push(args);
    return [{ id: 'other', name: 'MySQL' }] as T;
  };
  await expect(ensureRailwayMysql(path, state(), existing)).rejects.toThrow('unrecorded');
  const missing: RailwayCommand = async <T>(args: string[]) => {
    calls.push(args);
    return [] as T;
  };
  await expect(
    ensureRailwayMysql(path, { ...state(), mysql: { service: 'gone', name: 'MySQL' } }, missing)
  ).rejects.toThrow('missing');
  await expect(
    ensureRailwayMysql(path, { ...state(), mysql: { name: 'MySQL', creating: true } }, missing)
  ).rejects.toThrow('incomplete');
  expect(calls.every((args) => args[0] === 'service')).toBe(true);
});
