import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createConfig, expansions } from '../src/config';
import { prepareDotnetFiles } from '../src/emulators/dotnet/init';
import { dotnetSources } from '../src/emulators/dotnet/source';
import { resolveSource } from '../src/emulators/source';
import { prepareSphereFiles, sphereConfigValue } from '../src/emulators/sphere/config';
import { resolveLatestSphereSources, sphereXSources } from '../src/emulators/sphere/source';
import { sphereFixture, sphereSettings } from './sphere/config-fixture';

test('Sphere-X resolves the matching server and script repositories', async () => {
  const urls: string[] = [];
  const pair = await resolveLatestSphereSources(async (url) => {
    urls.push(url);
    return Response.json({ sha: 'a'.repeat(40) });
  }, 'sphere-x');
  expect(pair.server.repository).toBe(sphereXSources.server.repository);
  expect(pair.scripts.repository).toBe(sphereXSources.scripts.repository);
  expect(urls).toEqual([
    'https://api.github.com/repos/Sphereserver/Source-X/commits/master',
    'https://api.github.com/repos/Sphereserver/Scripts-X/commits/main'
  ]);
});

test('shared source resolution rejects invalid revisions and does not fall back', async () => {
  for (const source of Object.values(dotnetSources)) {
    await expect(resolveSource(source, 'test', async () => Response.json({ sha: 'short' }))).rejects.toThrow(
      'invalid commit'
    );
  }
});

const owner = { owner: 'admin', autoCreateAccounts: false };
const password = 'test-password';
const runuo = {
  'Scripts/Misc/ServerList.cs':
    'public static readonly string ServerName = "RunUO TC";\npublic static readonly bool AutoDetect = true;',
  'Scripts/Misc/DataPath.cs': 'private static string CustomPath = null;',
  'Scripts/Misc/CurrentExpansion.cs': 'private static readonly Expansion Expansion = Expansion.TOL;',
  'Scripts/Accounting/AccountHandler.cs': 'private static bool AutoAccountCreation = true;',
  'Data/custom.bin': Buffer.from([0, 255, 1])
};

test('RunUO writes editable native scripts, maps unsupported EJ to TOL, and seeds a hashed owner', () => {
  const config = createConfig({ emulator: 'runuo', name: 'My "Shard"' });
  const files = prepareDotnetFiles(runuo, config, owner, password);
  expect(files['Scripts/Misc/ServerList.cs']).toContain(`ServerName = ${JSON.stringify(config.name)};`);
  expect(files['Scripts/Misc/DataPath.cs']).toContain('"data/client"');
  expect(files['Scripts/Misc/CurrentExpansion.cs']).toContain('Expansion.TOL');
  expect(files['Scripts/Accounting/AccountHandler.cs']).toContain('AutoAccountCreation = false;');
  expect(files['Data/custom.bin']).toEqual(runuo['Data/custom.bin']);
  const xml = files['Saves/Accounts/accounts.xml'] as string;
  const digest = createHash('sha1')
    .update('admin' + password)
    .digest('hex')
    .toUpperCase()
    .match(/../g)!
    .join('-');
  expect(xml).toContain(`<newCryptPassword>${digest}</newCryptPassword>`);
  expect(xml).toContain('<accessLevel>Owner</accessLevel>');
  expect(xml).not.toContain(password);
  expect(() => prepareDotnetFiles({ ...runuo, 'Scripts/Misc/DataPath.cs': '' }, config, owner, password)).toThrow(
    'Unsupported upstream'
  );
});

test('ModernUO writes native JSON for every expansion and an importable owner seed', () => {
  const upstream = {
    'Distribution/Data/expansions.json': JSON.stringify(expansions.map((entry, Id) => ({ Id, Name: entry.label })))
  };
  for (const expansion of expansions) {
    const config = createConfig({ emulator: 'modernuo', expansion: expansion.value });
    const files = prepareDotnetFiles(upstream, config, owner, password);
    const settings = JSON.parse(files['Configuration/modernuo.json'] as string);
    expect(settings.listeners).toEqual(['0.0.0.0:2593']);
    expect(settings.dataDirectories).toEqual(['data/client']);
    expect(settings.settings['accountHandler.enableAutoAccountCreation']).toBe('false');
    expect(JSON.parse(files['Configuration/expansion.json'] as string).Name).toBe(expansion.label);
    expect(files['Saves/Accounts/accounts.xml']).not.toContain(password);
  }
  expect(() => createConfig({ emulator: 'modernuo', runuo: owner })).toThrow('Invalid runuo settings');
  expect(() => createConfig({ emulator: 'runuo', runuo: { ...owner, owner: '<bad>' } })).toThrow(
    'Invalid runuo settings'
  );
});

test('Sphere-X uses AccApp, protects the owner and selects Script-X map includes without classic rule masks', () => {
  const upstream = sphereFixture();
  upstream['sphere.ini'] = (upstream['sphere.ini'] as string)
    .replace('AutoAccountCreation=0', 'AccApp=0\r\nLocalIPAdmin=1')
    .replace('FeatureExtra=', 'FeatureExtra = ');
  upstream['scripts/spheretables.scp'] = '[RESOURCES]\n';
  for (let map = 0; map < 6; map++) {
    for (const extension of ['', '_ml', '_hs']) {
      const path = `maps/map${map}/map${map}_areas${extension}.scp`;
      upstream[`scripts/${path}`] = '// map\n';
      upstream['scripts/spheretables.scp'] += path + '\n';
    }
  }
  upstream['scripts/maps/map1/map1_areas_aos_old_haven.scp'] = '// old Haven';
  upstream['scripts/spheretables.scp'] += '//maps/map1/map1_areas_aos_old_haven.scp\n';
  const config = createConfig({ emulator: 'sphere-x', expansion: 'uor', timezone: 'Europe/London' });
  const files = prepareSphereFiles(upstream, config, { ...sphereSettings, autoCreateAccounts: true }, password);
  const ini = Buffer.from(files['sphere.ini']!).toString('latin1');
  const tables = Buffer.from(files['scripts/spheretables.scp']!).toString('latin1');
  expect(sphereConfigValue(ini, 'AccApp')).toBe('2');
  expect(sphereConfigValue(ini, 'LocalIPAdmin')).toBe('0');
  expect(sphereConfigValue(ini, 'CombatFlags')).toBe('0');
  expect(tables).toContain('\nmaps/map1/map1_areas.scp\n');
  expect(tables).toContain('\n//maps/map1/map1_areas_ml.scp\n');
  expect(tables).toContain('\n//maps/map2/map2_areas.scp\n');
  const modern = prepareSphereFiles(upstream, { ...config, expansion: 'ej' }, sphereSettings, password);
  expect(Buffer.from(modern['scripts/spheretables.scp']!).toString()).toContain(
    '\n//maps/map1/map1_areas_aos_old_haven.scp\n'
  );
});
