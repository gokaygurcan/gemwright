import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type DeployParts, deploy as runDeploy } from '@gemwright/deployment/deploy';
import { loadShard } from '@gemwright/server/config';
import { deployments } from '@gemwright/server/staging';

import { deployAi } from './ai-deploy';
import { stageImage } from './assets';
import { deployClient } from './client-deploy';
import { withServicePackages } from './service-packages';

export type { DeployParts, RailwayCommand, RailwayState } from '@gemwright/deployment/deploy';
export { ensureRailway, ensureRailwayMysql } from '@gemwright/deployment/deploy';

export { deployments };
export async function deploy(options: DeployParts, directory = process.cwd()) {
  const config = await loadShard(directory);
  const selected = (['server', 'client', 'ai'] as const).filter(
    (part) => options[part] || (part === 'server' && !options.client && !options.ai)
  );
  return withServicePackages(config, selected, async (paths) => {
    const adapters = paths.server
      ? (await import(pathToFileURL(join(paths.server, 'dist/staging.js')).href)).deployments
      : deployments;
    const stage = (image: 'ai' | 'client', context: string) => stageImage(image, context, undefined, paths[image]);
    return runDeploy(
      {
        loadShard,
        deployments: adapters,
        deployAi: (dir, files) => deployAi(dir, files, stage),
        deployClient: (dir, files, prepared) => deployClient(dir, files, prepared, stage),
        progress: console.log
      },
      options,
      directory
    );
  });
}
