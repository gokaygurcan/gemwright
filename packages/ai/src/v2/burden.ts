import type { PlayerSession } from '@gemwright/network/session';

import type { Outcome } from './beliefs';
import { worth } from './choose';
import { harvestBy, isKeepsake, tools } from './knowledge';
import type { Mind } from './mind';

// Makes room at the value of what is put down, preserving the proposed action's inputs.
// Weights come from observed hovers; an unknown weight cannot promise carrying room.
export function burden(
  mind: Mind,
  session: PlayerSession,
  outcome: Partial<Outcome>,
  consumes: readonly number[] = []
) {
  const world = session.world;
  const status = world.status;
  if (!status) return { cost: 0, drops: [] as number[] };
  const weigh = (things: Record<string, number> = {}) =>
    Object.entries(things).reduce((sum, [name, n]) => sum + (mind.unitWeight(name) ?? 0) * n, 0);
  const excess = status.weight + weigh(outcome.gained) - weigh(outcome.lost) - status.maxWeight;
  if (excess <= 0) return { cost: 0, drops: [] as number[] };
  const items = droppable(mind, session, consumes);
  const drops: number[] = [];
  let freed = 0;
  let lost = 0;
  for (const item of items) {
    if (freed >= excess) break;
    drops.push(item.serial);
    freed += item.weight;
    lost += item.worth;
  }
  for (const item of items) {
    if (item.weight < excess || item.worth >= lost) continue;
    lost = item.worth;
    drops.splice(0, drops.length, item.serial);
  }
  return freed >= excess ? { cost: mind.cost(lost), drops } : undefined;
}

export function droppable(mind: Mind, session: PlayerSession, consumes: readonly number[] = []) {
  const world = session.world;
  const using = new Set(consumes);
  const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === 21);
  return [...mind.belongings()]
    .filter(([serial, item]) => {
      const entity = world.entities.get(serial);
      return (
        mind.canDrop(serial) &&
        pack !== undefined &&
        entity?.parent === pack.serial &&
        !using.has(serial) &&
        !harvestBy(item.name) &&
        !tools.has(entity?.graphic ?? 0) &&
        !isKeepsake(item.name) &&
        (mind.described(serial)?.weight ?? 0) > 0
      );
    })
    .map(([serial, item]) => ({
      serial,
      weight: mind.described(serial)?.weight ?? 0,
      worth: worth(item.name) * item.amount
    }))
    .sort((a, b) => a.worth / a.weight - b.worth / b.weight);
}
