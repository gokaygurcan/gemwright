import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configFilename, createConfig, type ShardConfig } from './config';

export async function loadShard(directory: string): Promise<ShardConfig> {
  let input: ShardConfig;
  try {
    input = JSON.parse(await readFile(join(directory, configFilename), 'utf8'));
  } catch {
    throw new Error(`Cannot read ${configFilename}. Run gemwright init in the shard directory first.`);
  }
  for (const key of ['name', 'id', 'timezone', 'expansion', 'emulator'] as const) {
    if (typeof input[key] !== 'string') throw new Error(`Invalid ${configFilename}: missing ${key}.`);
  }
  const config = createConfig(input);
  if (config.id !== input.id || !config.id)
    throw new Error('The recorded shard ID must be a non-empty slug derived from its name.');
  return config;
}
