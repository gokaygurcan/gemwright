import { cp } from 'node:fs/promises';
import { basename } from 'node:path';

// Finder and AppleDouble files from macOS never belong on the server.
export const copyShardFiles = (source: string, target: string) =>
  cp(source, target, { recursive: true, filter: (path) => !/^(?:\.DS_Store|\._.*)$/.test(basename(path)) });
