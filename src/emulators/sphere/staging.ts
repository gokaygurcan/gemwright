import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { assetPath } from '../../assets';
import type { ShardConfig } from '../../config';
import { command } from '../../process';
import { packageClientFiles as packageFiles } from '../client-files';
import { sphereConfigValue } from './config';
import { applySphereCompatibility, sphereSources } from './source';

export async function validateSphereShard(directory: string, config: ShardConfig): Promise<void> {
  const scripts = config.sphere?.scriptsSource;
  if (
    config.source?.repository !== sphereSources.server.repository ||
    config.source.ref !== sphereSources.server.ref ||
    !scripts ||
    scripts.repository !== sphereSources.scripts.repository ||
    scripts.ref !== sphereSources.scripts.ref
  )
    throw new Error('Missing or unsupported Sphere source pair. Initialize a shard to record both revisions.');
  const ini = await readFile(join(directory, 'sphere.ini'), 'latin1');
  for (const [key, value] of Object.entries({
    ServPort: '2593',
    ScpFiles: 'scripts/',
    WorldSave: 'save/',
    AcctFiles: 'accounts/',
    MulFiles: 'data/client/',
    Log: 'logs/'
  })) {
    if (sphereConfigValue(ini, key) !== value)
      throw new Error(`Sphere deployment currently requires ${key}=${value}. Config was not changed.`);
  }
  for (const folder of ['scripts', 'accounts', 'save']) {
    if (!(await stat(join(directory, folder))).isDirectory()) throw new Error(`Missing Sphere ${folder} directory.`);
  }
}

export async function stageSphere(directory: string, config: ShardConfig): Promise<string> {
  await validateSphereShard(directory, config);
  const context = join(directory, '.gemwright/deploy');
  await rm(context, { recursive: true, force: true });
  const server = join(context, 'server');
  await mkdir(server, { recursive: true });
  await command(['git', 'init', '--quiet'], server);
  await command(
    ['git', 'fetch', '--quiet', '--depth', '1', config.source!.repository, config.source!.revision],
    server
  );
  await command(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], server);
  await applySphereCompatibility(server, config.source!.revision);
  await rm(join(server, '.git'), { recursive: true, force: true });
  await mkdir(join(context, 'shard'));
  for (const name of ['sphere.ini', 'sphereCrypt.ini', 'scripts'])
    await cp(join(directory, name), join(context, 'shard', name), { recursive: true });
  for (const name of ['accounts', 'save'])
    await cp(join(directory, name), join(context, 'seed', name), { recursive: true });
  for (const [source, target] of [
    ['Dockerfile', 'Dockerfile'],
    ['railway-start.sh', 'start.sh'],
    ['start.sh', 'run-server.sh']
  ] as const)
    await cp(assetPath(`templates/sphere/${source}`), join(context, target));
  return context;
}

const clientPattern =
  /^(?:map[0-5](?:LegacyMUL\.uop|\.mul)|statics[0-5]\.mul|staidx[0-5]\.mul|(?:mapdif|mapdifl|stadif|stadifl|stadifi)[0-5]\.mul|multi\.(?:idx|mul)|hues\.mul|tiledata\.mul|verdata\.mul)$/i;

export async function packageClientFiles(directory: string, sourcePath: string) {
  const ini = await readFile(join(directory, 'sphere.ini'), 'latin1');
  return packageFiles(directory, sourcePath, clientPattern, (names) => {
    const required = ['tiledata.mul', 'hues.mul', 'multi.idx', 'multi.mul'];
    for (let map = 0; map < 6; map++) {
      if (!sphereConfigValue(ini, `Map${map}`)) continue;
      required.push(`statics${map}.mul`, `staidx${map}.mul`);
      if (!names.includes(`map${map}.mul`) && !names.includes(`map${map}legacymul.uop`))
        throw new Error(`Sphere client files need map${map}.mul or map${map}LegacyMUL.uop for enabled Map${map}.`);
    }
    const missing = required.filter((name) => !names.includes(name));
    if (missing.length)
      throw new Error(
        `Sphere client files are missing: ${missing.join(', ')}. MultiCollection.uop is not a replacement for multi.idx/multi.mul in this Sphere version.`
      );
  });
}
