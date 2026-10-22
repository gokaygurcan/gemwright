import type { CharacterArchetype } from './archetypes';
import type { PlayerSession } from './protocol/session';
import { skillId } from './skills';

// Craft and gathering characters (craftsman, fisherman, tailor, alchemist, bowyer) never leave town
// work for dungeons; everyone else graduates at
// 80.0 primaries and may go alone once both primaries reach 100.0.
const crafters = new Set(['craftsman', 'fisherman', 'tailor', 'alchemist', 'bowyer']);
const dungeonSkill = 80;
const soloSkill = 100;
const renounceSkill = 60;

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

// Any resident with a primary skill at 60.0 base gives up its Young status as a player would: by
// saying the keyword phrase (speech ID 0x0035, Keywords.cs) and pressing OKAY (button 1) on the
// RenounceYoungGump. A character that is no longer Young gets no gump, so nothing is pressed.
export function outgrewYoung(session: PlayerSession, archetype: CharacterArchetype | undefined): boolean {
  return !!archetype?.primarySkills.some(
    (name) => (session.world.skills.get(skillId(name))?.base ?? 0) >= renounceSkill
  );
}

export async function renounceYoung(session: PlayerSession) {
  const shown = new Set(session.world.gumps.keys());
  session.say('I renounce my young player status');
  await session
    .waitFor(() => [...session.world.gumps.keys()].some((key) => !shown.has(key)), 'young renouncement', 5000)
    .catch(() => {});
  const gump = [...session.world.gumps.entries()].find(([key]) => !shown.has(key))?.[1];
  if (gump) session.replyGump(gump.serial, gump.id, 1, []);
  return !!gump;
}
