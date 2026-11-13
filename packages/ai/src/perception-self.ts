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
    attributes: status && { strength: status.strength, dexterity: status.dexterity, intelligence: status.intelligence },
    statCap: status?.statCap ?? null,
    // Strength, dexterity, intelligence: 0 up, 1 down, 2 locked.
    statLocks: world.statLocks && [...world.statLocks],
    followers: status?.followers === undefined ? null : { current: status.followers, max: status.maxFollowers ?? 0 },
    resists: status?.resists ? { physical: status.armor, ...status.resists } : null,
    luck: status?.luck ?? null,
    damage: status?.damage ?? null,
    // Its body as the server draws it, and whether it is flying (a gargoyle's flag 0x04).
    body: world.entities.get(world.serial ?? -1)?.graphic ?? null,
    notoriety: world.entities.get(world.serial ?? -1)?.notoriety ?? null,
    flying: !!((world.entities.get(world.serial ?? -1)?.flags ?? 0) & 4)
  };
}
