import { assetPath } from '../../assets';
import type { EmulatorSource } from '../../config';
import { applyCompatibility } from '../compatibility';

export const servuoSource = {
  repository: 'https://github.com/ServUO/ServUO.git',
  ref: 'pub57',
  patch: assetPath('patches/servuo-pub57-hosting.patch')
} as const;

export async function resolveLatestServuoSource(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<EmulatorSource> {
  try {
    const response = await fetcher(`https://api.github.com/repos/ServUO/ServUO/commits/${servuoSource.ref}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gemwright' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== 'object' ||
      !('sha' in result) ||
      typeof result.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(result.sha)
    ) {
      throw new Error('GitHub returned an invalid commit revision');
    }
    return { repository: servuoSource.repository, ref: servuoSource.ref, revision: result.sha };
  } catch (error) {
    throw new Error(
      `Could not resolve the latest ServUO ${servuoSource.ref} revision. Check your connection and retry. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function applyServuoCompatibility(directory: string, expectedRevision: string) {
  return applyCompatibility(directory, expectedRevision, servuoSource.patch, 'ServUO');
}
