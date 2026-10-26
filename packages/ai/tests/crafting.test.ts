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

test('profit crafting can still attempt a viable recipe at skill 100', async () => {
  const { trainCraft, chooseRecipe } = await import('../src/craft-training');
  const { skillId } = await import('@gemwright/common/skills');
  const { behaviorFixture, required } = await import('./behavior-fixture');
  const { ctx, session, world, checkpoint } = behaviorFixture();
  checkpoint.funds = { bank: 0, at: Date.now() };
  world.skills.set(skillId('Tailoring'), { value: 100, base: 100, cap: 100, lock: 0 });
  world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xf9d, parent: 10 });
  world.entities.set(13, { serial: 13, kind: 'item', graphic: 0x1766, parent: 10, amount: 10 });
  world.gumps.set('1:1', {
    serial: 1,
    id: 1,
    packed: false,
    layout:
      '{ xmfhtmlgumpcolor 50 10 150 18 1011375 0 0 32767 }' +
      '{ button 220 60 4005 4007 1 0 2 }{ xmfhtmlgumpcolor 255 63 220 18 1027027 0 0 32767 }'
  });
  let requested = 0;
  session.replyGump = () => {
    requested++;
    world.journal.push({ at: new Date().toISOString(), serial: 1, name: '', cliloc: 1044038 });
  };
  session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('No craft result');
  };
  const craft = {
    skill: 'Tailoring',
    vendor: 'tailor' as const,
    tools: new Set([0xf9d]),
    toolPrice: 5,
    material: 0x1766,
    unitCost: 1,
    recipes: [{ name: 'test garment', group: 1011375, label: 1027027, min: 0, max: 100, amount: 1, pays: 10 }]
  };
  expect(chooseRecipe(craft, 100, 'profit')).toBeDefined();
  expect(
    await trainCraft(
      { ...ctx, serial: 1, status: () => required(world.status), carried: (pack) => world.childrenOf(pack) },
      craft,
      10,
      Date.now() + 1000,
      { mode: 'profit', skill: 100 }
    )
  ).toBe(1);
  expect(requested).toBe(1);
});
