import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetPath } from '../../assets';
import type { ShardConfig } from '../../config';
import { command } from '../../process';
import { packageClientFiles as packageFiles } from '../../client-files';
import { configValue, setConfigValue } from './config';
import { applyServuoCompatibility, servuoSource } from './source';

export async function validateServuoShard(directory: string, config: ShardConfig): Promise<void> {
  if (
    !config.source ||
    config.source.repository !== servuoSource.repository ||
    config.source.ref !== servuoSource.ref
  ) {
    throw new Error('Missing or unsupported ServUO source. Initialize a new shard to record its source revision.');
  }
  const server = await readFile(join(directory, 'Config/Server.cfg'), 'utf8');
  if (configValue(server, 'Port') !== '2593' || configValue(server, 'Listen') !== '0.0.0.0') {
    throw new Error(
      'Railway deployment currently requires Server.cfg Listen=0.0.0.0 and Port=2593. Config was not changed.'
    );
  }
  const data = await readFile(join(directory, 'Config/DataPath.cfg'), 'utf8');
  if (
    configValue(data, 'CustomPath') !== 'data/client' &&
    configValue(data, 'CustomPath') !== config.servuo?.clientFiles
  )
    throw new Error('Deployment currently supports DataPath.cfg CustomPath=data/client. Config was not changed.');
  const restart = await readFile(join(directory, 'Config/AutoRestart.cfg'), 'utf8').catch(() => 'Enabled=False');
  if (configValue(restart, 'Enabled')?.toLowerCase() === 'true') {
    throw new Error(
      'ServUO self-restarts are not supported by the container startup wrapper yet. Config was not changed.'
    );
  }
}

export async function stageServuo(directory: string, config: ShardConfig): Promise<string> {
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
  await applyServuoCompatibility(server, config.source!.revision);
  await rm(join(server, '.git'), { recursive: true, force: true });
  await rm(join(server, 'Config'), { recursive: true, force: true });
  await cp(join(directory, 'Config'), join(server, 'Config'), { recursive: true });
  const dataPath = join(server, 'Config/DataPath.cfg');
  await writeFile(dataPath, setConfigValue(await readFile(dataPath, 'utf8'), 'CustomPath', 'data/client'));
  for (const folder of ['Scripts', 'Data']) {
    if ((await stat(join(directory, folder)).catch(() => undefined))?.isDirectory())
      await cp(join(directory, folder), join(server, folder), { recursive: true });
  }
  await cp(join(directory, 'Saves'), join(context, 'seed/Saves'), { recursive: true });
  for (const [source, target] of [
    ['Dockerfile', 'Dockerfile'],
    ['railway-start.sh', 'start.sh'],
    ['start.sh', 'run-server.sh']
  ] as const) {
    await cp(assetPath(`templates/servuo/${source}`), join(context, target));
  }
  return context;
}

const clientPattern =
  /^(?:map[0-5](?:LegacyMUL\.uop|\.mul)|statics[0-5]\.mul|staidx[0-5]\.mul|(?:mapdif|mapdifl|stadif|stadifl|stadifi)[0-5]\.mul|multi\.(?:idx|mul)|MultiCollection\.uop|tiledata\.mul|verdata\.mul)$/i;

export function packageClientFiles(directory: string, sourcePath: string) {
  return packageFiles(directory, sourcePath, clientPattern, (lower) => {
    if (!lower.includes('tiledata.mul') || !(lower.includes('map0.mul') || lower.includes('map0legacymul.uop')))
      throw new Error('Client files must include tiledata.mul and map0.mul or map0LegacyMUL.uop.');
  });
}
