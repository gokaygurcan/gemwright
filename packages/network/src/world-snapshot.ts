import type { WorldView } from './world';

export function worldSnapshot(world: WorldView) {
  return {
    ready: world.ready,
    connected: world.connected,
    viewRange: world.viewRange,
    serial: world.serial,
    position: world.position,
    map: world.map,
    status: world.status,
    combatant: world.combatant,
    deathSite: world.deathSite,
    healthChanges: world.healthChanges,
    skills: Object.fromEntries(world.skills),
    warMode: world.warMode,
    poisonLevel: world.poisonLevel,
    entities: [...world.entities.values()],
    journal: [...world.journal],
    target: world.target,
    gumps: [...world.gumps.values()],
    revision: world.revision,
    received: Object.fromEntries(
      [...world.received].map(([id, count]) => [`0x${id.toString(16).padStart(2, '0')}`, count])
    )
  };
}
