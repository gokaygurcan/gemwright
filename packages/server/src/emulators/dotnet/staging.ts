import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { assetPath } from '../../assets';
import type { ShardConfig } from '../../config';
import { required } from '../../required';
import { packageClientFiles } from '../servuo/staging';
import { checkoutSource, removeSourceHistory } from '../source';
import { applyDotnetCompatibility, type DotnetEmulator, dotnetSources } from './source';

export { packageClientFiles };

export async function validateDotnetShard(directory: string, config: ShardConfig) {
  const expected = dotnetSources[config.emulator as DotnetEmulator];
  if (!expected || config.source?.repository !== expected.repository || config.source.ref !== expected.ref)
    throw new Error('Missing or unsupported emulator source. Initialize a shard to record its revision.');
  for (const folder of config.emulator === 'runuo'
    ? ['Scripts', 'Data', 'Saves']
    : ['Projects/UOContent', 'Distribution/Data', 'Configuration', 'Saves'])
    if (!(await stat(join(directory, folder))).isDirectory()) throw new Error(`Missing ${folder}.`);
  if (config.emulator === 'runuo') {
    const data = await readFile(join(directory, 'Scripts/Misc/DataPath.cs'), 'utf8');
    const sockets = await readFile(join(directory, 'Scripts/Misc/SocketOptions.cs'), 'utf8');
    if (!/CustomPath\s*=\s*"data\/client"/.test(data) || !/new IPEndPoint\(\s*IPAddress.Any,\s*2593\s*\)/.test(sockets))
      throw new Error('RunUO deployment requires data/client and listener 0.0.0.0:2593. Scripts were not changed.');
  }
  if (config.emulator === 'modernuo') {
    const settings = JSON.parse(await readFile(join(directory, 'Configuration/modernuo.json'), 'utf8'));
    if (
      JSON.stringify(settings.listeners) !== '["0.0.0.0:2593"]' ||
      JSON.stringify(settings.dataDirectories) !== '["data/client"]' ||
      settings.settings?.['world.savePath'] !== 'Saves'
    )
      throw new Error(
        'ModernUO deployment requires listener 0.0.0.0:2593, data/client and Saves. Config was not changed.'
      );
  }
}

export async function stageDotnet(directory: string, config: ShardConfig): Promise<string> {
  await validateDotnetShard(directory, config);
  const emulator = config.emulator as DotnetEmulator;
  const context = join(directory, '.gemwright/deploy');
  await rm(context, { recursive: true, force: true });
  const server = join(context, 'server');
  await checkoutSource(server, required(config.source, 'emulator source'));
  for (const folder of emulator === 'runuo' ? ['Scripts', 'Data'] : ['Projects/UOContent', 'Distribution/Data']) {
    await rm(join(server, folder), { recursive: true, force: true });
    await cp(join(directory, folder), join(server, folder), { recursive: true });
  }
  await applyDotnetCompatibility(server, required(config.source, 'emulator source').revision, emulator);
  await removeSourceHistory(server);
  await cp(join(directory, 'Saves'), join(context, 'seed/Saves'), { recursive: true });
  if (emulator === 'modernuo')
    await cp(join(directory, 'Configuration'), join(server, 'Distribution/Configuration'), { recursive: true });
  await mkdir(join(context, 'seed'), { recursive: true });
  for (const name of ['Dockerfile', 'railway-start.sh', 'start.sh']) {
    const source = name === 'Dockerfile' ? emulator : 'dotnet';
    await cp(
      assetPath(`templates/${source}/${name}`),
      join(context, name === 'railway-start.sh' ? 'start.sh' : name === 'start.sh' ? 'run-server.sh' : name)
    );
  }
  return context;
}
