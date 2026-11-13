import { expect, test } from 'bun:test';

import { Self } from '../src/v2/self';

const sheet = (value: number) => ({ value, base: value, cap: 100, lock: 0 });

test('its skills and stats tell what it can do by ServUO rules', () => {
  const self = new Self();
  self.observe({
    resident: 'r',
    at: 1,
    kind: 'awake',
    data: {
      sheet: { Swords: sheet(60), Parry: sheet(80), AnimalTaming: sheet(30), Blacksmith: sheet(45) },
      self: { attributes: { strength: 60, dexterity: 80, intelligence: 20 }, weight: { current: 100, max: 300 } }
    }
  });
  self.observe({
    resident: 'r',
    at: 2,
    kind: 'skill',
    data: { skill: 'Parry', value: 80.1, before: 80, base: 80.1, cap: 100, lock: 2 }
  });
  const can = self.abilities();
  expect(self.skills.get('Parry')).toEqual({ value: 80.1, base: 80.1, cap: 100, lock: 2 });
  expect(can.weapons).toEqual([{ skill: 'Swords', value: 60 }]);
  expect(can.crafts).toEqual([{ skill: 'Blacksmith', value: 45 }]);
  expect(can.parry.shield).toBeCloseTo(80.1 / 400);
  expect(can.parry.twoHanded).toBeCloseTo(80.1 / 800);
  expect(can.tames.find((c) => c.name === 'Horse')?.chance).toBeCloseTo((30 - 29.1 + 0.1) / 50);
  expect(can.carries).toBe(200);
});
