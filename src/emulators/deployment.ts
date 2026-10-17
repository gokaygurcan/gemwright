import type { Emulator, ShardConfig } from '../config';
import { packageClientFiles as packageServuoFiles, stageServuo, validateServuoShard } from './servuo/staging';
import { packageClientFiles as packageSphereFiles, stageSphere, validateSphereShard } from './sphere/staging';

interface EmulatorDeployment {
  label: string;
  validate(directory: string, config: ShardConfig): Promise<void>;
  stage(directory: string, config: ShardConfig): Promise<string>;
  packageFiles(
    directory: string,
    sourcePath: string,
    config: ShardConfig
  ): Promise<{ archive: string; digest: string; bytes: number }>;
}

export const deployments: Record<Emulator, EmulatorDeployment> = {
  servuo: { label: 'ServUO', validate: validateServuoShard, stage: stageServuo, packageFiles: packageServuoFiles },
  sphere: { label: 'Sphere', validate: validateSphereShard, stage: stageSphere, packageFiles: packageSphereFiles }
};
