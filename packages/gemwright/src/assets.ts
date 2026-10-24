import { existsSync } from 'node:fs';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gemwright package's own files (templates, patches, package.json).
export function assetPath(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

// The repository's workspace files (the other packages, the root manifest and lockfile). Run
// from the repository, they are read in place; an installed package carries the copy that
// `bun run build` writes to workspace/ (build.ts).
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const inRepository = existsSync(join(repository, 'packages/gemwright/src/assets.ts'));
export function workspacePath(path: string): string {
  return inRepository ? join(repository, path) : assetPath(`workspace/${path}`);
}

// What each image is built from: files placed at the context's root, then the files of each
// package it needs, in their workspace layout.
export const images = {
  ai: {
    root: ['Dockerfile', 'railway.json'],
    packages: { common: ['src'], ai: ['start.sh', 'src', 'world', 'templates', 'locations', 'catalogs'] }
  },
  client: {
    root: ['Dockerfile', 'railway.json', '.dockerignore', '.railwayignore'],
    packages: { common: ['src'], client: ['build.ts', 'files.ts', 'server.ts', 'web', 'runtime'] }
  }
} as const;

// A Docker build context for one image: its root files from packages/<image>, the root manifest
// (without scripts, which only serve development) and lockfile with every workspace's manifest
// (the lockfile names them all, so the image installs from it frozen), then the packages' files.
export async function stageImage(
  image: keyof typeof images,
  context: string,
  root: readonly string[] = images[image].root
): Promise<void> {
  for (const path of root) await cp(workspacePath(`packages/${image}/${path}`), join(context, path));
  await stageManifests(context);
  for (const [name, paths] of Object.entries(images[image].packages))
    for (const path of paths)
      await cp(workspacePath(`packages/${name}/${path}`), join(context, 'packages', name, path), { recursive: true });
}

export async function stageManifests(target: string): Promise<void> {
  const { scripts: _, ...manifest } = JSON.parse(await readFile(workspacePath('package.json'), 'utf8'));
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(workspacePath('bun.lock'), join(target, 'bun.lock'));
  for (const workspace of await readdir(workspacePath('packages'))) {
    const path = `packages/${workspace}/package.json`;
    if (existsSync(workspacePath(path))) await cp(workspacePath(path), join(target, path));
  }
}
