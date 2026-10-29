import type { WorldView } from '@gemwright/network/world';

export function selfProjection(world: WorldView) {
  const status = world.status;
  return {
    position: world.position ? { ...world.position } : null,
    map: world.map,
    health: status && { current: status.hits, max: status.maxHits },
    mana: status && { current: status.mana, max: status.maxMana },
    stamina: status && { current: status.stamina, max: status.maxStamina },
    weight: status && { current: status.weight, max: status.maxWeight },
    gold: status?.gold ?? null,
    poison: world.poisonLevel,
    range: world.viewRange,
    attributes: status && { strength: status.strength, dexterity: status.dexterity, intelligence: status.intelligence }
  };
}
