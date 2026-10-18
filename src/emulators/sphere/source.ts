import { assetPath } from '../../assets';
import type { EmulatorSource } from '../../config';
import { applyCompatibility } from '../compatibility';
import { resolveSource } from '../source';

export const sphereSources = {
  server: { repository: 'https://github.com/Sphereserver/Source.git', ref: 'master' },
  scripts: { repository: 'https://github.com/Sphereserver/Scripts.git', ref: 'master' }
} as const;

export interface SphereSources {
  server: EmulatorSource;
  scripts: EmulatorSource;
}

export const sphereXSources = {
  server: { repository: 'https://github.com/Sphereserver/Source-X.git', ref: 'master' },
  scripts: { repository: 'https://github.com/Sphereserver/Scripts-X.git', ref: 'main' }
} as const;

export function sourcesFor(emulator: string) {
  return emulator === 'sphere-x' ? sphereXSources : sphereSources;
}

export async function resolveLatestSphereSources(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch,
  emulator = 'sphere'
): Promise<SphereSources> {
  const sources = sourcesFor(emulator);
  const label = emulator === 'sphere-x' ? 'Sphere-X' : 'Sphere';
  const [server, scripts] = await Promise.all([
    resolveSource(
      sources.server,
      `${label} ${sources.server.repository.split('/').pop()!.replace('.git', '')}`,
      fetcher
    ),
    resolveSource(
      sources.scripts,
      `${label} ${sources.scripts.repository.split('/').pop()!.replace('.git', '')}`,
      fetcher
    )
  ]);
  return { server, scripts };
}

export const spherePatch = assetPath('patches/sphere-hosting.patch');

export function applySphereCompatibility(directory: string, expectedRevision: string, emulator = 'sphere') {
  return applyCompatibility(
    directory,
    expectedRevision,
    emulator === 'sphere-x' ? assetPath('patches/sphere-x-hosting.patch') : spherePatch,
    'Sphere'
  );
}
