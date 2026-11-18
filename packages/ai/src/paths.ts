import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The package's folder, whether running from source or a build (a build bundles this file into each
// entry, so import.meta.url is the entry's).
export const packageRoot = pathToFileURL(`${dirname(dirname(fileURLToPath(import.meta.url)))}/`);

// A worker entry (such as 'persistence-worker'), from source or from the build.
export const workerEntry = (name: string) =>
  import.meta.url.endsWith('.ts') ? new URL(`src/${name}.ts`, packageRoot) : new URL(`dist/${name}.js`, packageRoot);
