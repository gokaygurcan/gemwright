import { expect, test } from 'bun:test';

import { HAMMER_SERIAL, startShard } from './fixtures/v2/crafting-shard';
import { gumpId, recorded, runResident } from './fixtures/v2/resident-run';

const ROOT = 100;
const WEAPONS = 101;
const ARMOR = 102;
const CRAFT_WEAPONS = 'gump-response 100:1 > gump-response 101:11';
const CRAFT_ARMOR = 'gump-response 100:2 > gump-response 102:21';

// The smith's menus behind the hammer: a root of categories (100), a weapons branch (101) and an
// armor branch (102), each branch with one recipe and one way back to the root. Nothing names any
// of it to the resident: it has to open the hammer, read the menu, choose a category, read that,
// choose a recipe — and find its way back to try the other branch.
const recipe = {
  anvil: { x: 105, y: 100, z: 0 },
  hammer: 5091,
  menus: [
    {
      id: ROOT,
      buttons: [
        { button: 1, opens: WEAPONS },
        { button: 2, opens: ARMOR }
      ]
    },
    {
      id: WEAPONS,
      buttons: [
        { button: 11, crafts: true, ingots: 5 },
        { button: 12, opens: ROOT }
      ]
    },
    {
      id: ARMOR,
      buttons: [
        { button: 21, crafts: true, ingots: 3 },
        { button: 22, opens: ROOT }
      ]
    }
  ],
  itemType: 'StuddedChest',
  itemGraphic: 5083,
  itemPrice: 10,
  ingotsPerCraft: 5,
  successes: [true, true],
  hammerUses: 6,
  skillGainTenths: 1
};

const carried = (items: Record<string, number> = {}, type: string) =>
  Object.entries(items)
    .filter(([name]) => name.split('/').includes(type))
    .reduce((total, [, amount]) => total + amount, 0);

test('the resident discovers a menu of categories, works a recipe in each, and navigates back by its own buttons', async () => {
  const shard = startShard({ coldAfterFirstSale: false, vendors: ['Armorer', 'Miner'], blacksmithing: recipe });
  const events = await runResident(
    shard,
    (list) => {
      const entries = recorded(list);
      const crafts = entries.filter(
        (entry) => entry.kind === 'outcome' && /gump-response/.test(String(entry.data.key ?? ''))
      );
      return (
        crafts.some((entry) => String(entry.data.key ?? '').includes(CRAFT_WEAPONS)) &&
        crafts.some((entry) => String(entry.data.key ?? '').includes(CRAFT_ARMOR))
      );
    },
    45_000
  );
  const list = recorded(events);

  // Every depth was discovered from what the shard answered: the root, then both branches.
  const menus = new Set(list.filter((entry) => entry.kind === 'gump').flatMap((entry) => [gumpId(entry)]));
  expect(menus.has(ROOT)).toBe(true);
  expect(menus.has(WEAPONS)).toBe(true);
  expect(menus.has(ARMOR)).toBe(true);

  // It worked a recipe in the weapons branch and one in the armor branch, each through the whole
  // chain of answers that leads there.
  const weaponCraft = list.find(
    (entry) => entry.kind === 'outcome' && String(entry.data.key ?? '').includes(CRAFT_WEAPONS)
  );
  const armorCraft = list.find(
    (entry) => entry.kind === 'outcome' && String(entry.data.key ?? '').includes(CRAFT_ARMOR)
  );
  expect(weaponCraft).toBeDefined();
  expect(armorCraft).toBeDefined();
  if (!weaponCraft || !armorCraft) throw new Error('A branch of the menu was never worked');
  expect(carried(weaponCraft.data.observed?.gained, recipe.itemType)).toBeGreaterThanOrEqual(1);
  expect(carried(weaponCraft.data.observed?.lost, 'IronIngot')).toBe(5);
  expect(carried(armorCraft.data.observed?.gained, recipe.itemType)).toBeGreaterThanOrEqual(1);
  expect(carried(armorCraft.data.observed?.lost, 'IronIngot')).toBe(3);
  expect(
    list.some((entry) => entry.kind === 'considered' && String(entry.data.doing ?? '').includes(CRAFT_WEAPONS))
  ).toBe(true);

  // It navigated back: a branch's back button was answered, and the root menu came up again —
  // and the chain stayed known, so the other branch was worked afterwards.
  const back = list.find(
    (entry) =>
      entry.kind === 'acted' &&
      entry.data.verb === 'gump-response' &&
      entry.data.gump === WEAPONS &&
      entry.data.button === 12
  );
  expect(back).toBeDefined();
  if (!back) throw new Error('The way back was never answered');
  const rootAgain = list.find((entry) => entry.kind === 'gump' && gumpId(entry) === ROOT && entry.index > back.index);
  expect(rootAgain).toBeDefined();
  expect(weaponCraft.index).toBeLessThan(back.index);
  expect(armorCraft.index).toBeGreaterThan(back.index);
  expect(
    list.some(
      (entry) => entry.kind === 'acted' && entry.data.verb === 'double-click' && entry.data.serial === HAMMER_SERIAL
    )
  ).toBe(true);
}, 120_000);
