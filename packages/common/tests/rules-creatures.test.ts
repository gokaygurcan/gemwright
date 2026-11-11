import { expect, test } from 'bun:test';

import { creatureFacts } from '../src/game/rules-creatures';

// A skill set to one value (PlagueBeast: SetSkill(SkillName.Wrestling, 100.0)) counts as much as one
// set to a range (Ogre: 70.1 to 80.0, its highest).
test('a creature skill set to a single value is read', () => {
  const body = `SetSkill(SkillName.Tactics, 100.0);
    SetSkill(SkillName.Wrestling, 70.1, 80.0);
    : base(AIType.AI_Melee, FightMode.Closest, 10, 1, 0.2, 0.4)`;
  expect(creatureFacts(body)).toMatchObject({ tactics: 100, wrestling: 80 });
});

// A caster's spell damage scales with its Evaluating Intelligence and Int (ServUO
// Spell.GetNewAosDamage): both are read.
test('a creature evaluating intelligence and int are read', () => {
  const body = `SetInt(226, 250);
    SetSkill(SkillName.EvalInt, 100.1, 110.0);
    : base(AIType.AI_Mage, FightMode.Closest, 10, 1, 0.2, 0.4)`;
  expect(creatureFacts(body)).toMatchObject({ evalInt: 110, int: [226, 250] });
});
