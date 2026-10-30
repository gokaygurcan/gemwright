import type { GameFile } from '@gemwright/client/files';
import { deployClient as deploy } from '@gemwright/deployment/client-deploy';
import { loadShard } from '@gemwright/server/config';

import { stageImage } from './assets';
export function deployClient(directory: string, assets: string, preparedFiles?: GameFile[], stage = stageImage) {
  return deploy({ loadShard, stageImage: stage, progress: console.log }, directory, assets, preparedFiles);
}
