import { expect, test } from 'bun:test';

import { bestRecipe, buttonFor, RAW_INGOT_VALUE } from '../src/miner-crafting';
import { choosePastime } from '../src/miner-pastimes';
import { useSkill } from '../src/protocol/packets';

test('best value at blacksmithy 50 beats raw ingots', () => {
  const best = bestRecipe(50);
  expect(best?.name).toBe('wooden kite shield');
  expect(best?.perIngot).toBeCloseTo(35 / 8, 2);
  expect(best?.perIngot ?? 0).toBeGreaterThan(RAW_INGOT_VALUE);
});

test('higher skill makes heater shields the better use of iron', () => {
  expect(bestRecipe(80)?.name).toBe('heater shield');
});

test('craft gump buttons are found beside their localized labels', () => {
  const layout =
    '{ button 15 80 4005 4007 1 0 1 }{ xmfhtmlgumpcolor 50 83 150 18 1011080 0 0 32767 }' +
    '{ button 220 60 4005 4007 1 0 2 }{ xmfhtmlgumpcolor 255 63 220 18 1027027 0 0 32767 }' +
    '{ button 220 160 4005 4007 1 0 37 }{ xmfhtmlgumpcolor 255 163 220 18 1027032 0 0 32767 }';
  expect(buttonFor(layout, 1011080)).toBe(1);
  expect(buttonFor(layout, 1027032)).toBe(37);
  expect(buttonFor(layout, 1027035)).toBeUndefined();
});

test('miners pick a weighted pastime instead of quitting', () => {
  expect(choosePastime(['smith', 'train', 'wander'], () => 0)).toBe('smith');
  expect(choosePastime(['smith', 'train', 'wander'], () => 0.5)).toBe('train');
  expect(choosePastime(['smith', 'train', 'wander'], () => 0.99)).toBe('wander');
  expect(choosePastime(['wander'], () => 0.3)).toBe('wander');
  expect(choosePastime([])).toBeUndefined();
});

test('skill use is encoded as the client skill button request', () => {
  expect([...useSkill(4)]).toEqual([0x12, 0, 8, 0x24, 0x34, 0x20, 0x30, 0]);
  expect(() => useSkill(58)).toThrow('Invalid skill id');
});
