import { expect, test } from 'bun:test';

import { empty } from '../src/beliefs';
import { honestly, usual, value, worth } from '../src/choose';
import { traitsOf } from '../src/traits';

// Picking up what lies on the ground is taking; looting a creature it saw die, or its own corpse, is
// not. An honest resident counts what it takes for as little as it is honest.
test('what it takes counts for as little as it is honest', () => {
  const traits = { ...traitsOf([], () => 0.5).traits, honesty: 0.75 };
  const shield = { ...empty(), gained: { MetalShield: 1 } };
  const gained = (key: string) => honestly(key, shield, traits).gained.MetalShield;
  expect([
    gained('pick-up MetalShield > drop my Backpack'),
    gained('pick-up MetalShield in Corpse of Orc > drop my Backpack'),
    gained('pick-up MetalShield in my Corpse > drop my Backpack'),
    gained('pick-up my MetalShield > equip my MetalShield'),
    gained('pick-up MetalShield in Corpse > drop my Backpack')
  ]).toEqual([0.25, 1, 1, 1, 0.25]);
});

// No vendor buys iron ore, but a forge makes an iron ingot of each, which a smith buys.
test('ore is worth the ingots it makes', () => {
  expect(worth('IronOre')).toBe(worth('IronIngot'));
  expect(worth('IronOre')).toBeGreaterThan(0);
});

test('earning replacement-tool money counts even when a fight trains another trade', () => {
  const traits = traitsOf([], () => 0.5).traits;
  const trade = new Set(['Mining', 'Blacksmith']);
  const rates = { gold: 1, skill: 1 };
  const rat = { ...empty(), seconds: 5, gained: { Gold: 15 }, skill: 0.1, skills: { Tactics: 0.1 } };
  const dig = { ...empty(), seconds: 5, gained: { IronOre: 5 }, skill: 0.1, skills: { Mining: 0.1 } };
  expect(value(rat, traits, rates, 0, trade)).toBeGreaterThan(0);
  expect(value(rat, traits, rates, 0, trade)).toBe(value({ ...rat, skill: 0, skills: {} }, traits, rates, 0, trade));
  expect(value(dig, traits, rates, 0, trade)).toBeGreaterThan(
    value({ ...dig, skill: 0, skills: {} }, traits, rates, 0, trade)
  );
});

// Having earned a little gold in its first minute, a coin does not count as a whole minute of its life.
test('what it usually earns starts from a fair guess, not from its first few coins', () => {
  const early = usual([{ ...empty(), seconds: 60, gained: { Gold: 1 } }]);
  expect(early.gold).toBeGreaterThan(0.5);
});
