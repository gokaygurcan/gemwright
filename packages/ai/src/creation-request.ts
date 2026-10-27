import { skillId } from '@gemwright/common/skills';

import { appearanceOf } from './appearance';
import { createCharacter } from './protocol/packets';
import type { CharacterRequest } from './protocol/session';
import { shardProfile } from './shard-profile';
import type { Resident, ResidentStore } from './store';

// A new resident's first login creates its character from its template; a bound one logs in.
export function creationRequest(store: ResidentStore, resident: Resident, enabled: boolean): CharacterRequest {
  if (!enabled || resident.binding) return { slot: 0 };
  const template = store.template(resident.templateId, resident.creationVersion);
  if (!template) throw new Error('Resident creation template is missing');
  if (template.creation.equipment.length)
    throw new Error('Custom starting equipment cannot be provisioned through this ordinary creation profile');
  const name = resident.proposedName;
  const skills = Object.entries(template.creation.skills).map(([skill, value]) => {
    const id = skillId(skill);
    return { id, value };
  });
  const create = {
    name,
    city: template.creation.city,
    skills,
    appearance: appearanceOf(resident.id, shardProfile().races)
  };
  createCharacter({ ...create, city: 0, slot: 0 });
  return { slot: 0, create };
}
