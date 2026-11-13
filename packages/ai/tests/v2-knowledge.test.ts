import { expect, test } from 'bun:test';

import { harvestTiles } from '@gemwright/common/game/rules';

import { facts, foreseeHarvest, foreseeSmelt, identify } from '../src/v2/knowledge';

// A grandmaster miner on an unknown vein mostly digs iron, and now and then the richer ores its
// skill reaches (ServUO Mining.cs veins); a novice digs only iron.
test('a harvest foresees the richer resources the skill reaches', () => {
  const rock = { land: harvestTiles.rock.land[0] };
  const master = foreseeHarvest('Pickaxe', rock, () => 100)?.gained ?? {};
  expect(master.IronOre).toBeGreaterThan(0.5);
  expect(master.ValoriteOre).toBeGreaterThan(0);
  expect(Object.values(master).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
  const novice = foreseeHarvest('Pickaxe', rock, () => 50)?.gained ?? {};
  expect(Object.keys(novice)).toEqual(['IronOre']);
});

// Smelting a pile of iron ore at 60 Mining (ServUO Ore.cs, difficulty 50 ± 25): usually ingots, one
// for each ore, otherwise half the ore burnt away.
test('smelting foresees ingots by the chance its Mining gives', () => {
  expect(foreseeSmelt('IronOre', 10, 0x19b8, 60)).toEqual({ gained: { IronIngot: 7 }, lost: { IronOre: 8.5 } });
  expect(foreseeSmelt('ValoriteOre', 10, 0x19b8, 60)).toEqual({ lost: {}, gained: {} });
});

// Ore all looks alike; its hover says what metal it is (ServUO BaseOre: "ore", then the resource's
// name, valorite 1053101). Plain ore says no metal: iron.
test('the hover tells one ore or ingot from another', () => {
  const ore = (properties: { cliloc: number; arguments: string }[]) =>
    identify({ kind: 'item', graphic: 6584, properties });
  expect(
    ore([
      { cliloc: 1026583, arguments: '' },
      { cliloc: 1053101, arguments: '' }
    ])
  ).toEqual(['ValoriteOre']);
  expect(ore([{ cliloc: 1050039, arguments: '12\t#1026583' }])).toEqual(['IronOre']);
  expect(
    identify({
      kind: 'item',
      graphic: 7154,
      properties: [
        { cliloc: 1027154, arguments: '' },
        { cliloc: 1053108, arguments: '' }
      ]
    })
  ).toEqual(['DullCopperIngot']);
});

// A hover read as a player reads it: the pile's weight, and what a weapon or armour piece says.
test('a hover tells what a piece weighs and how good it is', () => {
  expect(
    facts([
      { cliloc: 1050039, arguments: '12\t#1026583' },
      { cliloc: 1072789, arguments: '144' }
    ])
  ).toEqual({ weight: 144 });
  expect(
    facts([
      { cliloc: 1038021, arguments: '' },
      { cliloc: 1060636, arguments: '' },
      { cliloc: 1061168, arguments: '11\t13' },
      { cliloc: 1061167, arguments: '2.75s' },
      { cliloc: 1061170, arguments: '40' },
      { cliloc: 1060448, arguments: '5' },
      { cliloc: 1060639, arguments: '30\t40' },
      { cliloc: 1072788, arguments: '1' }
    ])
  ).toEqual({
    blessed: true,
    exceptional: true,
    damage: [11, 13],
    speed: 2.75,
    strength: 40,
    resists: { physical: 5 },
    durability: [30, 40],
    weight: 1
  });
});

test('before its hover, an ingot is known by its colour (ServUO ResourceInfo hues)', () => {
  expect(identify({ kind: 'item', graphic: 7154, hue: 0x966 })).toEqual(['ShadowIronIngot']);
  expect(identify({ kind: 'item', graphic: 7154, hue: 0 })).toEqual(['IronIngot']);
});

test('a hover the shard did not answer is asked again', async () => {
  const { hover } = await import('../src/v2/hover');
  const { WorldView } = await import('@gemwright/network/world');
  const world = new WorldView();
  world.serial = 1;
  world.put({ serial: 5, kind: 'item', graphic: 7154, parent: 1 });
  let asks = 0;
  let stop = false;
  const session = {
    world,
    phase: 'ready',
    inspectProperties: async () => {
      if (++asks === 1) throw new Error('Timed out waiting for object properties');
      stop = true;
    }
  } as never;
  const mind = { belongings: () => new Map([[5, {}]]) } as never;
  await hover(
    session,
    mind,
    () => stop,
    new Set(),
    () => false,
    1
  );
  expect(asks).toBe(2);
});
