import type { Outcome } from './beliefs';
import { worth } from './choose';
import { harvestBy, isKeepsake, tools } from './knowledge';
import type { Mind } from './mind';

// Makes room at the value of what is put down, preserving the proposed action's inputs.
// Weights come from observed hovers; an unknown weight cannot promise carrying room.
export function burden(mind: Mind, outcome: Partial<Outcome>, consumes: readonly number[] = []) {
  const status = mind.self.weight;
  if (!status) return { cost: 0, drops: [] as number[] };
  const weigh = (things: Record<string, number> = {}) =>
    Object.entries(things).reduce((sum, [name, n]) => sum + (mind.unitWeight(name) ?? 0) * n, 0);
  const excess = status.current + weigh(outcome.gained) - weigh(outcome.lost) - status.max;
  if (excess <= 0) return { cost: 0, drops: [] as number[] };
  const items = droppable(mind, consumes);
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

export function droppable(mind: Mind, consumes: readonly number[] = []) {
  const using = new Set(consumes);
  const pack = mind.pack;
  return [...mind.belongings()]
    .filter(([serial, item]) => {
      return (
        mind.canDrop(serial) &&
        pack !== undefined &&
        mind.sight(serial)?.parent === pack &&
        !using.has(serial) &&
        !harvestBy(item.name) &&
        !tools.has(mind.graphicOf(serial) ?? 0) &&
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

// Over its limit with nothing better to do, it puts down the least it can to be under it again, as a
// player does: of what it carries loose in its pack, the part of a stack whose loss is worth least
// for the weight it frees. A unit weight not yet known is learned by putting down one and seeing what
// the shard counts afterwards.
export function shedding(mind: Mind): { serial: number; amount: number } | undefined {
  const weight = mind.self.weight;
  const pack = mind.pack;
  if (!weight || pack === undefined || weight.current <= weight.max) return undefined;
  const excess = weight.current - weight.max;
  const candidates = [...mind.belongings()]
    .filter(
      ([serial, item]) =>
        mind.canDrop(serial) &&
        mind.sight(serial)?.parent === pack &&
        !harvestBy(item.name) &&
        !tools.has(mind.graphicOf(serial) ?? 0) &&
        !isKeepsake(item.name)
    )
    .map(([serial, item]) => {
      const unit = mind.unitWeight(item.name);
      const amount = unit ? Math.min(item.amount, Math.ceil(excess / unit)) : 1;
      return { serial, amount, freed: unit ? unit * amount : undefined, lost: worth(item.name) * amount };
    })
    // What frees enough first, then what is known to free most for its worth; unknown last.
    .sort(
      (a, b) =>
        Number((b.freed ?? 0) >= excess) - Number((a.freed ?? 0) >= excess) ||
        (a.freed === undefined ? 1 : 0) - (b.freed === undefined ? 1 : 0) ||
        a.lost / (a.freed ?? 1) - b.lost / (b.freed ?? 1)
    );
  const chosen = candidates[0];
  return chosen && { serial: chosen.serial, amount: chosen.amount };
}
