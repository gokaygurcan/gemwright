import type { CharacterArchetype } from './archetypes';
import type { PlayerSession } from './protocol/session';
import { skillId } from './skills';

// Craft and gathering characters (craftsman, fisherman, tailor, alchemist, bowyer) never leave town
// work for dungeons; everyone else graduates at
// 80.0 primaries and may go alone once both primaries reach 100.0.
const crafters = new Set(['craftsman', 'fisherman', 'tailor', 'alchemist', 'bowyer']);
const dungeonSkill = 80;
const soloSkill = 100;

// Groundwork for dungeon play (not yet designed): true once a non-craft archetype has every primary
// skill at 80.0 base, as reported by the server's skill list.
export function readyForDungeons(session: PlayerSession, archetype: CharacterArchetype | undefined): boolean {
  return primariesAt(session, archetype, dungeonSkill);
}

export function soloDungeons(session: PlayerSession, archetype: CharacterArchetype | undefined): boolean {
  return primariesAt(session, archetype, soloSkill);
}

function primariesAt(session: PlayerSession, archetype: CharacterArchetype | undefined, skill: number): boolean {
  if (!archetype || crafters.has(archetype.id)) return false;
  return archetype.primarySkills.every((name) => (session.world.skills.get(skillId(name))?.base ?? 0) >= skill);
}
