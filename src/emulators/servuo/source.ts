import { assetPath } from '../../assets';
import type { EmulatorSource } from '../../config';
import { applyCompatibility } from '../compatibility';
import { resolveSource } from '../source';

export const servuoSource = {
  repository: 'https://github.com/ServUO/ServUO.git',
  ref: 'pub57',
  patch: assetPath('patches/servuo-pub57-hosting.patch'),
  // Applied on top of the hosting patch only when Gemwright's AI residents are deployed.
  aiPatch: assetPath('patches/servuo-pub57-ai.patch')
} as const;

export async function resolveLatestServuoSource(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<EmulatorSource> {
  return resolveSource(servuoSource, 'ServUO', fetcher);
}

export async function applyServuoCompatibility(directory: string, expectedRevision: string, ai = false) {
  const hosting = await applyCompatibility(directory, expectedRevision, servuoSource.patch, 'ServUO');
  if (ai) await applyCompatibility(directory, expectedRevision, servuoSource.aiPatch, 'ServUO AI');
  return hosting;
}
