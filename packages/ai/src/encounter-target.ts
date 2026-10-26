import { distance } from './navigation';
import type { Entity } from './protocol/world';

export interface SwingObservation {
  target: number;
  at: number;
}

export function encounterTarget(options: {
  current: Entity;
  self: number;
  allies: ReadonlySet<number>;
  entities: Iterable<Entity>;
  swings: ReadonlyMap<number, SwingObservation>;
  origin: { x: number; y: number };
  committedUntil: number;
  eligible: (entity: Entity) => boolean;
  now?: number;
}): { target: Entity; reason?: string; overwhelmed?: boolean } {
  const { current, self, allies, swings, origin } = options;
  const now = options.now ?? Date.now();
  const attackers = [...options.entities].filter((entity) => {
    const swing = swings.get(entity.serial);
    return (
      entity.serial !== self &&
      !allies.has(entity.serial) &&
      !!entity.position &&
      distance(origin, entity.position) <= 12 &&
      swing &&
      now - swing.at >= 0 &&
      now - swing.at < 8000 &&
      (swing.target === self || allies.has(swing.target))
    );
  });
  // A nearby monster is not evidence that it joined this fight. Duels keep their target.
  if (!attackers.some((entity) => entity.serial !== current.serial)) return { target: current };
  if (attackers.length > allies.size + 2)
    return { target: current, overwhelmed: true, reason: 'More confirmed attackers than the nearby group can contain' };
  if (
    now < options.committedUntil ||
    (current.hits !== undefined && current.maxHits && current.hits / current.maxHits < 0.15)
  )
    return { target: current };
  const score = (entity: Entity) => {
    const attack = swings.get(entity.serial);
    return (
      (attack?.target === self ? 12 : 5) -
      distance(origin, entity.position ?? origin) +
      (entity.serial === current.serial ? 3 : 0)
    );
  };
  const next = attackers.filter(options.eligible).sort((a, b) => score(b) - score(a))[0];
  if (!next || next.serial === current.serial || score(next) <= score(current) + 3) return { target: current };
  return { target: next, reason: 'A confirmed additional attacker is threatening me at closer range' };
}
