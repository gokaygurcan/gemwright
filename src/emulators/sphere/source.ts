import { assetPath } from '../../assets';
import type { EmulatorSource } from '../../config';
import { applyCompatibility } from '../compatibility';

export const sphereSources = {
  server: { repository: 'https://github.com/Sphereserver/Source.git', ref: 'master' },
  scripts: { repository: 'https://github.com/Sphereserver/Scripts.git', ref: 'master' }
} as const;

export interface SphereSources {
  server: EmulatorSource;
  scripts: EmulatorSource;
}

export async function resolveLatestSphereSources(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<SphereSources> {
  async function resolve(kind: keyof SphereSources): Promise<EmulatorSource> {
    const source = sphereSources[kind];
    const repository = kind === 'server' ? 'Source' : 'Scripts';
    try {
      const response = await fetcher(`https://api.github.com/repos/Sphereserver/${repository}/commits/${source.ref}`, {
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
      return { ...source, revision: result.sha };
    } catch (error) {
      throw new Error(
        `Could not resolve the latest Sphere ${repository} ${source.ref} revision. Check your connection and retry. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const [server, scripts] = await Promise.all([resolve('server'), resolve('scripts')]);
  return { server, scripts };
}

export const spherePatch = assetPath('patches/sphere-hosting.patch');

export function applySphereCompatibility(directory: string, expectedRevision: string) {
  return applyCompatibility(directory, expectedRevision, spherePatch, 'Sphere');
}
