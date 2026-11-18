import { expect, test } from 'bun:test';

import { Fight } from '../src/fight';
import type { HistoryEvent } from '../src/history';
import { Mind } from '../src/mind';
import { traitsOf } from '../src/traits';

const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });

// Having seen itself swing a longsword (every 3s for 5) and a mongbat strike (every 2s), it
// foresees from the wiki that a mongbat dies in seconds while an ettin (90 hits, 60 wrestling,
// 7-17 damage) outlasts its 50 health.
test('a fight it never had is foreseen from the wiki and what it has seen of fights', () => {
  const fight = new Fight();
  const names = (serial: number) => (serial === 3 ? 'Mongbat/StrongMongbat' : undefined);
  fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 30 } }), names);
  fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), names);
  // Not yet seen a blow, it reckons with bare fists.
  expect(fight.foresee('Mongbat', 50)).toMatchObject({ killed: 1, died: 0 });

  fight.observe(event(0, 'screen', { key: 'combatant', value: 3 }), names);
  for (const at of [0, 3000, 6000]) {
    fight.observe(event(at, 'animated', { serial: 1, type: 0, action: 0 }), names);
    fight.observe(event(at + 100, 'damage', { key: 3, value: { at: at + 100, amount: 5 } }), names);
  }
  for (const at of [500, 2500]) fight.observe(event(at, 'animated', { serial: 3, type: null, action: 4 }), names);

  expect(fight.foresee('Mongbat', 50)).toMatchObject({ killed: 1, died: 0 });
  expect(fight.foresee('Mongbat', 50)?.seconds).toBeCloseTo(3.6, 1);
  expect(fight.foresee('Ettin', 50)).toMatchObject({ killed: 0, died: 1, health: -50 });
});

// Dying is a chance, not a line: a fight whose expected cost nearly matches its health is close to a
// coin toss, and one costing a fraction of it is safe.
test('the chance of dying grows as a fight expected cost nears its health', () => {
  const fight = new Fight();
  const names = (serial: number) => (serial === 3 ? 'Mongbat/StrongMongbat' : undefined);
  fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 30 } }), names);
  fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), names);
  fight.observe(event(0, 'screen', { key: 'combatant', value: 3 }), names);
  for (const at of [0, 3000, 6000]) {
    fight.observe(event(at, 'animated', { serial: 1, type: 0, action: 0 }), names);
    fight.observe(event(at + 100, 'damage', { key: 3, value: { at: at + 100, amount: 5 } }), names);
  }
  for (const at of [500, 2500]) fight.observe(event(at, 'animated', { serial: 3, type: null, action: 4 }), names);
  const ettin = fight.foresee('Ettin', 1000);
  const lost = -(ettin?.health ?? 0);
  expect(ettin?.died).toBeLessThan(0.01);
  expect(fight.foresee('Ettin', lost)?.died).toBeCloseTo(0.5, 1);
  expect(fight.foresee('Ettin', lost / 3)?.died).toBeGreaterThan(0.99);
});

// Blows from a mongbat (listed 1-2) landing at half that tell how much its armour takes: an ettin
// it never fought is foreseen to hurt half as much as listed.
test('what its armour takes from listed damage carries to creatures it never fought', () => {
  const learn = (absorbing: boolean) => {
    const fight = new Fight();
    const names = (serial: number) => (serial === 3 ? 'Mongbat' : undefined);
    fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 30 } }), names);
    fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), names);
    fight.observe(event(0, 'screen', { key: 'combatant', value: 3 }), names);
    for (const at of [0, 3000, 6000]) {
      fight.observe(event(at, 'animated', { serial: 1, type: 0, action: 0 }), names);
      fight.observe(event(at + 100, 'damage', { key: 3, value: { at: at + 100, amount: 5 } }), names);
    }
    for (const at of [500, 2500]) {
      fight.observe(event(at, 'animated', { serial: 3, type: null, action: 4 }), names);
      if (absorbing) fight.observe(event(at + 50, 'damage', { key: 1, value: { at: at + 50, amount: 0.75 } }), names);
    }
    return -(fight.foresee('Ettin', 1000)?.health ?? 0);
  };
  expect(learn(true) / learn(false)).toBeCloseTo(0.5, 2);
});

// A lich casts: before it has seen any caster cast, it reckons with ServUO's casting pace, so a lich
// is already deadly; what it then sees of casting takes over.
test('a caster is foreseen with its spells before and after casting has been seen', () => {
  const fight = new Fight();
  const names = (serial: number) => (serial === 3 ? 'Mongbat' : serial === 4 ? 'Mage' : undefined);
  fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 90 } }), names);
  fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), names);
  fight.observe(event(0, 'screen', { key: 'combatant', value: 3 }), names);
  for (const at of [0, 3000, 6000]) {
    fight.observe(event(at, 'animated', { serial: 1, type: 0, action: 0 }), names);
    fight.observe(event(at + 100, 'damage', { key: 3, value: { at: at + 100, amount: 15 } }), names);
  }
  for (const at of [500, 2500]) fight.observe(event(at, 'animated', { serial: 3, type: null, action: 4 }), names);
  expect(fight.foresee('Lich', 100)?.died).toBeGreaterThan(0.9);
  expect(fight.foresee('Spectre', 100)?.died).toBeLessThan(0.5);
  for (const at of [1000, 5000]) fight.observe(event(at, 'animated', { serial: 4, type: 11, action: 0 }), names);
  expect(fight.foresee('Lich', 100)?.died).toBeGreaterThan(0.9);
});

// No kind is taken for harmless or hostile: how ready one is to start a fight is what those that came
// close did. Zombies that pass by stay calm; a mongbat that strikes first unasked is a foe, and so is
// its kind, more with each one that does.
test('how ready a kind is to fight is learned from those that came close', () => {
  const fight = new Fight();
  const names = (serial: number) => (serial < 10 ? 'Zombie' : 'Mongbat');
  fight.observe(event(0, 'awake', { serial: 100, skills: { Swords: 90 } }), names);
  expect(fight.aggression('Zombie')).toBe(0.5);
  for (const serial of [3, 4, 5, 6]) fight.near(serial, 'Zombie');
  expect(fight.aggression('Zombie')).toBeLessThan(0.2);
  fight.near(11, 'Mongbat');
  fight.observe(event(100, 'animated', { serial: 11, type: 0, action: 0 }), names);
  fight.observe(event(200, 'damage', { key: 100, value: { at: 200, amount: 2 } }), names);
  expect(fight.foe(11)).toBe(true);
  expect(fight.aggression('Mongbat')).toBeGreaterThan(0.6);
  // One it attacked itself only answers: that says nothing of its kind.
  fight.observe(event(300, 'screen', { key: 'combatant', value: 5 }), names);
  fight.observe(event(400, 'animated', { serial: 5, type: 0, action: 0 }), names);
  fight.observe(event(500, 'damage', { key: 100, value: { at: 500, amount: 2 } }), names);
  expect(fight.foe(5)).toBe(true);
  expect(fight.aggression('Zombie')).toBeLessThan(0.2);
});

// An evil mage's spells reach it at a fraction of what the wiki says: its resistances, as felt, make a lich's
// spells less deadly too.
test('spells are foreseen as its resistances let them through', () => {
  const lich = (resisting: boolean) => {
    const fight = new Fight();
    const names = (serial: number) => (serial === 3 ? 'Mongbat' : serial === 4 ? 'EvilMage' : undefined);
    fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 90 } }), names);
    fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), names);
    fight.observe(event(0, 'screen', { key: 'combatant', value: 3 }), names);
    for (const at of [0, 3000, 6000]) {
      fight.observe(event(at, 'animated', { serial: 1, type: 0, action: 0 }), names);
      fight.observe(event(at + 100, 'damage', { key: 3, value: { at: at + 100, amount: 15 } }), names);
    }
    for (const at of [500, 2500]) fight.observe(event(at, 'animated', { serial: 3, type: null, action: 4 }), names);
    for (const at of [1000, 5000]) {
      fight.observe(event(at, 'animated', { serial: 4, type: 11, action: 0 }), names);
      if (resisting) fight.observe(event(at + 50, 'damage', { key: 1, value: { at: at + 50, amount: 1 } }), names);
    }
    return fight;
  };
  expect(lich(true).foresee('Lich', 100)?.died ?? 1).toBeLessThan(lich(false).foresee('Lich', 100)?.died ?? 0);
});

// A skeleton that struck it while it fought something else: anything but fighting back risks dying
// of its blows, all the more the longer it takes; fighting it back does not.
test('a creature that struck it weighs on everything but fighting it back', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 30, max: 30 } }, skills: { Swords: 50 } }));
  mind.observe(event(0, 'gained', { serial: 9, kind: 'item', graphic: 3821, amount: 500, parent: 2, is: ['Gold'] }));
  mind.observe(event(0, 'seen', { serial: 3, kind: 'mobile', graphic: 50, x: 1, y: 1, z: 0, is: ['Skeleton'] }));
  expect(mind.pressed(60)).toBe(0);
  mind.observe(event(100, 'animated', { serial: 3, type: 0, action: 0 }));
  mind.observe(event(200, 'damage', { key: 1, value: { at: 200, amount: 6 } }));
  expect(mind.pressed(5)).toBe(0);
  expect(mind.pressed(60)).toBeLessThan(0);
  expect(mind.pressed(60, 3)).toBe(0);
});

test('combat predictions follow a weapon moving between hand and backpack', () => {
  const fight = new Fight();
  const names = (serial: number) => (serial === 9 ? 'Longsword' : undefined);
  fight.observe(event(0, 'awake', { serial: 1, skills: { Wrestling: 75, Swords: 0 } }), names);
  const bare = fight.foresee('Mongbat', 100)?.seconds;
  fight.observe(event(1, 'gained', { serial: 9, parent: 1, layer: 1, is: ['Longsword'] }), names);
  const armed = fight.foresee('Mongbat', 100)?.seconds;
  expect(armed).toBeGreaterThan(bare as number);
  fight.observe(event(2, 'changed', { serial: 9, parent: 2, layer: undefined }), names);
  expect(fight.foresee('Mongbat', 100)?.seconds).toBe(bare);
  fight.observe(event(3, 'changed', { serial: 9, parent: 1, layer: 1 }), names);
  expect(fight.foresee('Mongbat', 100)?.seconds).toBe(armed);
  fight.observe(event(4, 'awake', { serial: 1, skills: { Wrestling: 75, Swords: 0 } }), names);
  expect(fight.foresee('Mongbat', 100)?.seconds).toBe(bare);
});

// ServUO gives no gain from a check it cannot fail (SkillCheck: "No challenge"): a swing sure to land
// teaches its weapon nothing, and Tactics is checked only as each blow lands.
test('a fight with no challenge teaches its weapon nothing', () => {
  const fight = new Fight();
  fight.observe(event(0, 'awake', { serial: 1, skills: { Swords: 80, Tactics: 80 } }), () => undefined);
  fight.observe(event(0, 'gained', { serial: 9, layer: 1, is: ['Longsword'] }), () => undefined);
  const bird = fight.foresee('Bird', 100);
  expect(bird?.skills.Swords ?? 0).toBe(0);
  expect(bird?.skills.Tactics ?? 0).toBeGreaterThan(0);
  expect(fight.foresee('Zombie', 100)?.skills.Swords ?? 0).toBeGreaterThan(0);
});
