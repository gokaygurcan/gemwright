import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI package's own files (templates, patches, package.json).
export function assetPath(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

// Read source assets in the repository and carried artifacts after installation.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const inRepository = existsSync(join(repository, 'packages/cli/src/assets.ts'));
export function workspacePath(path: string): string {
  return inRepository ? join(repository, path) : assetPath(`workspace/${path}`);
}

// Contained application artifacts: no workspace manifest or dependency installation at deploy time.
export const images = {
  ai: {
    root: ['Dockerfile', 'railway.json'],
    files: ['dist', 'catalogs', 'templates', 'world', 'tuning.json', 'start.sh']
  },
  client: {
    root: ['Dockerfile', 'railway.json', '.dockerignore', '.railwayignore'],
    files: ['bundle']
  }
} as const;

export async function stageImage(
  image: keyof typeof images,
  context: string,
  root: readonly string[] = images[image].root,
  source = workspacePath(`packages/${image}`)
): Promise<void> {
  for (const path of [...root, ...images[image].files])
    await cp(join(source, path), join(context, path), { recursive: true });
}
