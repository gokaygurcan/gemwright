import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

// The save files' date: for a pull, when it was downloaded.
export const savedAt = (saves: string) => statSync(join(saves, 'Mobiles/Mobiles.bin')).mtime;
