import { fileURLToPath } from 'node:url';

export function assetPath(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}
