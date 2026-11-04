import { HUMAN_BODIES } from '@gemwright/common/game/bodies';

import { monsters } from './monster-reference';
import type { BaselineTraits, CreaturePrior, Reference } from './perception-types';

type Creature = CreaturePrior & { bodies: readonly number[] };
const bodies = new Map<number, Creature[]>();
for (const creature of monsters as readonly Creature[])
  for (const body of creature.bodies) bodies.set(body, [...(bodies.get(body) ?? []), creature]);

const cached = new Map<string, Reference<BaselineTraits>>();

// Reference candidates are possibilities for an observed appearance, never a shard type assertion.
export function baselineTraits(graphic: number, name?: string): Reference<BaselineTraits> {
  const humanLike = HUMAN_BODIES.has(graphic);
  const key = `${graphic}:${humanLike ? '' : (name?.toLowerCase() ?? '')}`;
  const prior = cached.get(key);
  if (prior) return prior;
  const options = humanLike ? [] : (bodies.get(graphic) ?? []);
  const named = name ? options.filter((c) => c.name?.toLowerCase() === name.toLowerCase()) : [];
  const candidates = named.length ? named : options;
  const attitudes = new Set(candidates.map((c) => c.aggressive));
  const aggressive =
    attitudes.size === 1 && typeof candidates[0]?.aggressive === 'boolean' ? candidates[0].aggressive : null;
  const result: Reference<BaselineTraits> = {
    kind: 'reference',
    source: 'ServUO Scripts/Mobiles constructors (common rules)',
    value: {
      humanLike,
      aggressive,
      candidates: candidates.map((c) => ({
        type: c.type,
        name: c.name,
        aggressive: c.aggressive ?? null,
        hits: c.hits,
        damage: c.damage
      }))
    }
  };
  if (cached.size >= 2000) cached.clear();
  cached.set(key, result);
  return result;
}
