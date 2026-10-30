import { deployAi as deploy } from '@gemwright/deployment/ai-deploy';
import { loadShard } from '@gemwright/server/config';

import { stageImage } from './assets';
export function deployAi(directory: string, gameFiles: string, stage = stageImage) {
  return deploy({ loadShard, stageImage: stage, progress: console.log }, directory, gameFiles);
}
