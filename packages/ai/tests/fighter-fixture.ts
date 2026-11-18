import { skillId } from '@gemwright/common/game/skills';

import { behaviorFixture, required } from './behavior-fixture';

// A grandmaster swordsman with armor and no gold on hand.
export function fighterFixture() {
  const f = behaviorFixture();
  required(f.world.entities.get(1)).name = 'Dunstan Miller';
  for (const skill of ['Swordsmanship', 'Tactics', 'Anatomy', 'Healing', 'MagicResist'])
    f.world.skills.set(skillId(skill), { base: 100, value: 100, cap: 100, lock: 0 });
  required(f.world.status).armor = 40;
  required(f.world.status).gold = 0;
  required(f.world.entities.get(11)).amount = 0;
  Object.assign(f.session, { refreshStatus: async () => {}, refreshSkills: async () => {}, setWarMode: () => {} });
  return f;
}
