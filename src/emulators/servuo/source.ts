import { assetPath } from '../../assets';
import type { EmulatorSource } from '../../config';
import { applyCompatibility } from '../compatibility';
import { resolveSource } from '../source';

export const servuoSource = {
  repository: 'https://github.com/ServUO/ServUO.git',
  ref: 'pub57',
  patch: assetPath('patches/servuo-pub57-hosting.patch')
} as const;

export async function resolveLatestServuoSource(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<EmulatorSource> {
  return resolveSource(servuoSource, 'ServUO', fetcher);
}

export function applyServuoCompatibility(directory: string, expectedRevision: string) {
  return applyCompatibility(directory, expectedRevision, servuoSource.patch, 'ServUO');
}
