import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The package's folder, whether running from source or a build, at its top or in v1/ or v2/
// (a build bundles this file into each entry, so import.meta.url is the entry's).
const here = dirname(fileURLToPath(import.meta.url));
const top = ['v1', 'v2'].includes(basename(here)) ? dirname(here) : here;
export const packageRoot = pathToFileURL(`${dirname(top)}/`);

// A worker entry (such as 'v1/persistence-worker'), from source or from the build.
export const workerEntry = (name: string) =>
  import.meta.url.endsWith('.ts') ? new URL(`src/${name}.ts`, packageRoot) : new URL(`dist/${name}.js`, packageRoot);
