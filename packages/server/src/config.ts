import { createConfig as create, loadShard as load } from '@gemwright/common/config/shard';

import { validateRules } from './emulators/sphere/rules';

export type { Emulator } from '@gemwright/common/config/shard';
export {
  configFilename,
  defaultAdminEmail,
  defaultEmulator,
  defaultExpansion,
  defaultName,
  defaultTimezone,
  defaultWebsite,
  emulators,
  isAcceptedTimezone,
  shardId,
  timezoneOptions,
  validateAdminEmail,
  validateName,
  validateWebsite
} from '@gemwright/common/config/shard';
export type { AiSettings, EmulatorSource, ShardConfig } from '@gemwright/common/config/types';

export function createConfig(input: Parameters<typeof create>[0]) {
  return create(input, validateRules);
}
export function loadShard(directory: string) {
  return load(directory, validateRules);
}
