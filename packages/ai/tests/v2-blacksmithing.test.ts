import { expect, test } from 'bun:test';

import { ANVIL_GRAPHIC, HAMMER_SERIAL, startShard } from './fixtures/v2/crafting-shard';
import { gumpId, recorded, runResident } from './fixtures/v2/resident-run';

const SELL = /^sell /;
const CRAFT = /gump-response/;

// The smith's shop this shard runs: the hammer opens a trade menu (gump 42) with one button that
// works a studded chest from five ingots, training the skill and wearing the hammer; the vendor
// buys armor (paying 90 for a chest) and tools, but not raw ingots. None of that is told to the
// resident: it learns the menu by using the hammer on its own, and the chest's real price only by
// selling one.
const recipe = {
  anvil: { x: 105, y: 100, z: 0 },
  hammer: 5091,
  gump: 42,
  button: 21,
  itemType: 'StuddedChest',
  itemGraphic: 5083,
  itemPrice: 90,
  ingotsPerCraft: 5,
  successes: [true, true, true],
  hammerUses: 6,
  skillGainTenths: 1
};

const carried = (items: Record<string, number> = {}, type: string) =>
  Object.entries(items)
    .filter(([name]) => name.split('/').includes(type))
    .reduce((total, [, amount]) => total + amount, 0);

test('the resident discovers crafting by trying its tool, works the menu, and learns what the goods are worth', async () => {
  const shard = startShard({ coldAfterFirstSale: false, vendors: ['Armorer', 'Miner'], blacksmithing: recipe });
  const events = await runResident(shard, () => shard.state().craftAttempts >= 2 && shard.state().sales >= 2, 45_000);
  const list = recorded(events);
  const state = shard.state();

  // 1. It discovered the interaction by itself: it chose to use the hammer with no plan for it,
  // saw the menu open, and only then answered one of its buttons.
  const probe = list.find((entry) => entry.kind === 'plan-ended' && /^probe /.test(String(entry.data.id ?? '')));
  expect(probe).toBeDefined();
  expect(
    list.filter((entry) => entry.kind === 'plan-ended' && /^probe /.test(String(entry.data.id ?? '')))
  ).toHaveLength(1);
  const chose = list.find(
    (entry) =>
      entry.kind === 'considered' &&
      /^double-click my /.test(String(entry.data.doing ?? '')) &&
      !String(entry.data.doing ?? '').includes('>')
  );
  const used = list.find(
    (entry) => entry.kind === 'acted' && entry.data.verb === 'double-click' && entry.data.serial === HAMMER_SERIAL
  );
  const menu = list.find((entry) => entry.kind === 'gump' && gumpId(entry) === recipe.gump);
  const answered = list.find((entry) => entry.kind === 'acted' && entry.data.verb === 'gump-response');
  expect(used).toBeDefined();
  expect(menu).toBeDefined();
  expect(answered).toBeDefined();
  if (!chose || !used || !menu || !answered) throw new Error('The interaction was never discovered');
  expect(chose.index).toBeLessThan(menu.index);
  expect(used.index).toBeLessThan(menu.index);
  expect(menu.index).toBeLessThan(answered.index);
  expect(answered.data.gump).toBe(recipe.gump);
  expect(answered.data.button).toBe(recipe.button);
  expect(list.some((entry) => entry.kind === 'considered' && CRAFT.test(String(entry.data.doing ?? '')))).toBe(true);

  // 2. It learned the interaction by working it: the ingots it cost, the work it brought, the
  // skill it trained. Nothing about the menu's recipe was known before it answered.
  const crafts = list.filter((entry) => entry.kind === 'outcome' && CRAFT.test(String(entry.data.key ?? '')));
  expect(crafts.length).toBeGreaterThanOrEqual(2);
  const firstCraft = crafts[0];
  if (!firstCraft) throw new Error('The menu was never worked');
  expect(carried(firstCraft.data.observed?.lost, 'IronIngot')).toBeGreaterThanOrEqual(recipe.ingotsPerCraft);
  expect(carried(firstCraft.data.observed?.gained, recipe.itemType)).toBeGreaterThanOrEqual(1);
  expect(
    list.filter((entry) => entry.kind === 'skill' && entry.data.skill === 'Blacksmith').length
  ).toBeGreaterThanOrEqual(1);
  expect(state.hammerUses).toBeLessThan(recipe.hammerUses);

  // 3. The value of the work came from the market, not from the shard's hidden numbers: its first
  // sale of a chest paid the shard's real price, more than the rules' prior promised it.
  const sells = list.filter((entry) => entry.kind === 'outcome' && SELL.test(String(entry.data.key ?? '')));
  expect(sells.length).toBeGreaterThanOrEqual(2);
  const firstSale = sells[0];
  if (!firstSale) throw new Error('The work was never sold');
  const chests = carried(firstSale.data.observed?.lost, recipe.itemType);
  expect(chests).toBeGreaterThanOrEqual(1);
  const gold = firstSale.data.observed?.gained?.Gold ?? 0;
  expect(gold).toBe(chests * recipe.itemPrice);
  expect(gold).toBeGreaterThan(chests * 64); // the rules' prior for a studded chest
  expect(state.ingotsSoldRaw).toBe(0);

  // 4. Worthwhile, it kept at it: the second craft came after the first chest had been sold and
  // its real price seen, not before.
  const secondCraft = crafts[1];
  if (!secondCraft) throw new Error('The menu was never worked again');
  expect(secondCraft.index).toBeGreaterThan(firstSale.index);
  expect(state.craftAttempts).toBeGreaterThanOrEqual(2);
  expect(state.sales).toBeGreaterThanOrEqual(2);

  // The shop was there all along, seen and carried, and only ever worked through the discovered
  // interaction: nothing about it was scripted.
  expect(list.some((entry) => entry.kind === 'seen' && entry.data.graphic === ANVIL_GRAPHIC)).toBe(true);
  expect(
    list.some((entry) => ['revealed', 'gained'].includes(entry.kind) && entry.data.graphic === recipe.hammer)
  ).toBe(true);
}, 120_000);
