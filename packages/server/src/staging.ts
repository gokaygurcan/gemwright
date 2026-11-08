import { loadShard } from './config';
import { stageDotnet, validateDotnetShard } from './emulators/dotnet/staging';
import { packageClientFiles, servuoGameFiles, stageServuo, validateServuoShard } from './emulators/servuo/staging';
import {
  packageClientFiles as packageSphereFiles,
  sphereGameFiles,
  stageSphere,
  validateSphereShard
} from './emulators/sphere/staging';

export const deployments = {
  runuo: {
    label: 'RunUO',
    validate: validateDotnetShard,
    stage: stageDotnet,
    packageFiles: packageClientFiles,
    gameFiles: servuoGameFiles
  },
  modernuo: {
    label: 'ModernUO',
    validate: validateDotnetShard,
    stage: stageDotnet,
    packageFiles: packageClientFiles,
    gameFiles: servuoGameFiles
  },
  servuo: {
    label: 'ServUO',
    validate: validateServuoShard,
    stage: stageServuo,
    packageFiles: packageClientFiles,
    gameFiles: servuoGameFiles
  },
  sphere: {
    label: 'Sphere',
    validate: validateSphereShard,
    stage: stageSphere,
    packageFiles: packageSphereFiles,
    gameFiles: sphereGameFiles
  },
  'sphere-x': {
    label: 'Sphere-X',
    validate: validateSphereShard,
    stage: stageSphere,
    packageFiles: packageSphereFiles,
    gameFiles: sphereGameFiles
  }
};
export async function stage(directory: string, ai = false): Promise<string> {
  const config = await loadShard(directory);
  const adapter = deployments[config.emulator];
  await adapter.validate(directory, config);
  return adapter.stage(directory, config, { ai });
}
