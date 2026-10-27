import { skillId } from '@gemwright/common/skills';

import catalog from '../templates/archetypes.json';
// New Haven's builds live in their own file: the original catalog stays exactly as stored
// templates recorded it (store.ts compares snapshots).
import havenCatalog from '../templates/archetypes-new-haven.json';

export interface CharacterArchetype {
  id: string;
  version: number;
  primarySkills: string[];
  supportingSkills: string[];
  stats: { str: number; dex: number; int: number };
}

function validate(value: unknown): CharacterArchetype {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archetype');
  const input = value as Record<string, unknown>;
  const fields = ['id', 'version', 'primarySkills', 'supportingSkills', 'stats'];
  if (Object.keys(input).length !== fields.length || fields.some((field) => !(field in input)))
    throw new Error('Archetype requires id, version, primarySkills, supportingSkills, and stats');
  if (
    typeof input.id !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id) ||
    typeof input.version !== 'number' ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  )
    throw new Error('Invalid archetype identity');
  const skills = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name.trim() || name !== name.trim()))
      throw new Error(`Invalid skill list for archetype ${input.id}`);
    return value as string[];
  };
  const primarySkills = skills(input.primarySkills);
  const supportingSkills = skills(input.supportingSkills);
  const resolved = [...primarySkills, ...supportingSkills].map(skillId);
  if (!primarySkills.length || new Set(resolved).size !== resolved.length)
    throw new Error(`Archetype ${input.id} has no primary skills or repeats a skill`);
  if (!input.stats || typeof input.stats !== 'object' || Array.isArray(input.stats))
    throw new Error('Invalid stat targets');
  const stats = input.stats as Record<string, unknown>;
  if (
    Object.keys(stats).length !== 3 ||
    ['str', 'dex', 'int'].some(
      (name) => typeof stats[name] !== 'number' || !Number.isSafeInteger(stats[name]) || Number(stats[name]) < 1
    )
  )
    throw new Error(`Invalid stat targets for archetype ${input.id}`);
  return {
    id: input.id,
    version: input.version,
    primarySkills,
    supportingSkills,
    stats: { str: Number(stats.str), dex: Number(stats.dex), int: Number(stats.int) }
  };
}

if (catalog.schemaVersion !== 1 || havenCatalog.schemaVersion !== 1)
  throw new Error('Unsupported archetype catalog version');
export const archetypes: readonly CharacterArchetype[] = [...catalog.archetypes, ...havenCatalog.archetypes].map(
  validate
);
if (new Set(archetypes.map((build) => `${build.id}@${build.version}`)).size !== archetypes.length)
  throw new Error('Duplicate archetype versions');

export function resolveArchetype(value: unknown): CharacterArchetype {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archetype reference');
  const reference = value as Record<string, unknown>;
  const known = archetypes.find((build) => build.id === reference.id && build.version === reference.version);
  if (!known) throw new Error(`Unknown archetype ${String(reference.id)}@${String(reference.version)}`);
  if (Object.keys(reference).length !== 2 || !('id' in reference) || !('version' in reference)) {
    const snapshot = validate(value);
    if (JSON.stringify(snapshot) !== JSON.stringify(known))
      throw new Error(`Archetype ${known.id}@${known.version} differs from its catalog definition`);
  }
  return structuredClone(known);
}

// Supporting skills as trained, beyond the catalog: an archer also learns Wrestling, so it can
// fight on without arrows or bolts (fighter-encounter.ts). Kept out of the catalog so stored
// templates stay unchanged.
export const supportingOf = (archetype: CharacterArchetype | undefined) =>
  archetype
    ? [
        ...archetype.supportingSkills,
        ...(archetype.primarySkills.includes('Archery') && !archetype.supportingSkills.includes('Wrestling')
          ? ['Wrestling']
          : [])
      ]
    : undefined;
