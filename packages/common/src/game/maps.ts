import { ruleMaps } from './rules';

// Facets by map index (ServUO MapDefinitions.cs, rules.ts); 0x7F is the internal map, where
// logged-out characters wait.
export const MAPS: Record<number, string> = Object.fromEntries(
  Object.entries(ruleMaps).map(([id, map]) => [Number(id), map.name])
);
