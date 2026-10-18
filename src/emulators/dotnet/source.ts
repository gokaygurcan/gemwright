import { assetPath } from '../../assets';
import { applyCompatibility } from '../compatibility';
import { resolveSource } from '../source';

export const dotnetSources = {
  runuo: { repository: 'https://github.com/runuo/runuo.git', ref: 'master' },
  modernuo: { repository: 'https://github.com/modernuo/ModernUO.git', ref: 'main' }
} as const;
export type DotnetEmulator = keyof typeof dotnetSources;
export function resolveDotnetSource(emulator: DotnetEmulator) {
  return resolveSource(dotnetSources[emulator], emulator === 'runuo' ? 'RunUO' : 'ModernUO');
}
export function applyDotnetCompatibility(directory: string, revision: string, emulator: DotnetEmulator) {
  return applyCompatibility(directory, revision, assetPath(`patches/${emulator}-hosting.patch`), emulator);
}
