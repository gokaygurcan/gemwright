import { pathToFileURL } from 'node:url';

import { stage } from './staging';

export { deployments, stage } from './staging';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory || process.argv.slice(3).some((arg) => arg !== '--ai'))
    throw new Error('Usage: node dist/staging.js <shard-directory> [--ai]');
  console.log(await stage(directory, process.argv.includes('--ai')));
}
