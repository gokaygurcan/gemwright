import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadWorld, type World } from './servuo';

// A shard's world save, whatever wrote it. RunUO and ServUO keep a binary save (Items/Items.bin and
// Mobiles/Mobiles.bin with their .idx and .tdb, servuo.ts); Sphere keeps text (sphereworld.scp and
// spherechars.scp), recognised here but not read yet.
export type SaveFormat = 'servuo' | 'sphere';

export function saveFormat(folder: string): SaveFormat | undefined {
  if (existsSync(join(folder, 'Items/Items.bin'))) return 'servuo';
  if (existsSync(join(folder, 'sphereworld.scp'))) return 'sphere';
  return undefined;
}

export function loadSave(folder: string): World {
  const format = saveFormat(folder);
  if (format === 'servuo') return loadWorld(folder);
  if (format === 'sphere') throw new Error(`${folder} is a Sphere save; reading Sphere saves is not supported yet.`);
  throw new Error(`No world save in ${folder}: expected Items/Items.bin (RunUO, ServUO) or sphereworld.scp (Sphere).`);
}
