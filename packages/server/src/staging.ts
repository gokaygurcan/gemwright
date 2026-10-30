import { loadShard } from './config';
import { stageDotnet, validateDotnetShard } from './emulators/dotnet/staging';
import { packageClientFiles, stageServuo, validateServuoShard } from './emulators/servuo/staging';
import { packageClientFiles as packageSphereFiles, stageSphere, validateSphereShard } from './emulators/sphere/staging';

export const deployments = {
  runuo: { label: 'RunUO', validate: validateDotnetShard, stage: stageDotnet, packageFiles: packageClientFiles },
  modernuo: { label: 'ModernUO', validate: validateDotnetShard, stage: stageDotnet, packageFiles: packageClientFiles },
  servuo: { label: 'ServUO', validate: validateServuoShard, stage: stageServuo, packageFiles: packageClientFiles },
  sphere: { label: 'Sphere', validate: validateSphereShard, stage: stageSphere, packageFiles: packageSphereFiles },
  'sphere-x': { label: 'Sphere-X', validate: validateSphereShard, stage: stageSphere, packageFiles: packageSphereFiles }
};
export async function stage(directory: string, ai = false): Promise<string> {
  const config = await loadShard(directory);
  const adapter = deployments[config.emulator];
  await adapter.validate(directory, config);
  return adapter.stage(directory, config, { ai });
}
