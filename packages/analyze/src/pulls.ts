import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { pull } from 'gemwright/src/pull';

// Pulled world saves (gemwright pull) in a shard folder's .gemwright/pulls, newest first.
export function newestPull(directory = process.cwd()) {
  const pulls = resolve(directory, '.gemwright/pulls');
  const found = existsSync(pulls)
    ? readdirSync(pulls)
        .sort()
        .reverse()
        .map((stamp) => join(pulls, stamp, 'server/Saves'))
        .find((saves) => existsSync(join(saves, 'Mobiles')))
    : undefined;
  if (!found) throw new Error('No pulled saves here: run gemwright pull --server, or pass --local <Saves folder>.');
  return found;
}

// The shard's latest world save, pulled from its deployment into a new pull folder. ServUO
// writes the save on its own timer, so this is as current as its last save.
// With `cleanup`, older pulls are deleted once the new one is complete.
export async function pullLatest(directory = process.cwd(), cleanup = false) {
  await pull({ server: true, cleanup }, directory);
  return newestPull(directory);
}

// The save files' date: for a pull, when it was downloaded.
export const savedAt = (saves: string) => statSync(join(saves, 'Mobiles/Mobiles.bin')).mtime;
