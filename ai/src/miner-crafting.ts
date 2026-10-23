import { tally } from './activity';
import { chargedPurchase } from './bank-gold';
import { craftRecipes } from './craft-training';
import { serviceLocations } from './locations';
import type { createMinerServices } from './miner-services';
import { approachMobile } from './mobile-approach';
import { distance } from './navigation';
import { gumpCommands } from './protocol/gumps';
import type { Entity } from './protocol/world';
import { skillId } from './skills';

const ingot = 0x1bf2;
// Iron ingots are a vendor "economy" item on the pinned shard: 75% of the 5-gold sale price.
export const RAW_INGOT_VALUE = 3;
const tongs = new Set([0x0fbb, 0x0fbc]);
const smithTools = new Set([0x0fbb, 0x0fbc, 0x13e3, 0x13e4]);
const anvils = new Set([0x0faf, 0x0fb0, 0x2dd5, 0x2dd6]);
const forgeIds = new Set([0x0fb1, 0x2dd8, ...Array.from({ length: 48 }, (_, index) => 6522 + index)]);
const SHIELDS = 1011080;

// Every iron recipe the blacksmith buys back (catalogs/crafts/blacksmith.json from DefBlacksmithy
// and the Blacksmith's SB* sell lists: weapons, shields, chain, ring and plate armour). These are
// not economy items, so the table price applies (x1.25 exceptional, x0.6 low quality).
const recipes = craftRecipes('Blacksmith')
  .filter((recipe) => (recipe.pays ?? 0) > 0)
  .map((recipe) => ({
    ...recipe,
    name: recipe.name ?? 'item',
    max: recipe.max ?? recipe.min + 50,
    pays: recipe.pays ?? 0,
    ingots: recipe.amount
  }));

// Expected gold per ingot: a failed craft loses half the ingots (CraftItem, ConsumeType.Half).
export function bestRecipe(blacksmith: number) {
  return recipes
    .map((recipe) => {
      const chance = Math.max(0, Math.min(1, (blacksmith - recipe.min) / (recipe.max - recipe.min)));
      const used = chance * recipe.ingots + (1 - chance) * Math.max(1, Math.floor(recipe.ingots / 2));
      return { ...recipe, chance, perIngot: chance ? (chance * recipe.pays) / used : 0 };
    })
    .sort((a, b) => b.perIngot - a.perIngot)[0];
}

// Crafting replies: created (normal, exceptional, marked, low quality), failed (materials lost or
// not), tool worn out, missing anvil/forge, insufficient metal. Alchemy has its own pair (DefAlchemy:
// 500279 "You pour the potion into a bottle...", 500287 "You fail to create a useful potion").
// While the tool lasts, ServUO shows the
// result as the notice of the re-sent Blacksmithy menu (CraftGump at 170,295), not as a message.
export const CREATED = [1044154, 1044155, 1044156, 502785, 500279];
// Exceptional quality, with or without the maker's mark: such pieces are banked, not sold.
export const EXCEPTIONAL = [1044155, 1044156];
export const FAILED = [1044043, 1044157, 500287];
export const STOP = [1044038, 1044267, 1044037, 1044153];

// Finds the gump button placed beside a localized label (CraftGump puts each button 35 px left of
// and 3 px above its label), so a reordered recipe list cannot press the wrong item.
export function buttonFor(layout: string, cliloc: number): number | undefined {
  const commands = gumpCommands(layout);
  const label = commands.find((c) => c[0]?.startsWith('xmfhtml') && Number(c[5]) === cliloc);
  if (!label) return;
  const [x, y] = [Number(label[1]), Number(label[2])];
  return commands
    .filter(
      (c) => c[0] === 'button' && c[5] === '1' && Number(c[2]) === y - 3 && Number(c[1]) < x && x - Number(c[1]) <= 40
    )
    .map((c) => Number(c[7]))[0];
}

export function createSmithing(ctx: Parameters<typeof createMinerServices>[0]) {
  const { session, terrain, city, navigate, position, check, phase, log, carried, checkpoint } = ctx;
  const iron = (backpack: number) =>
    carried(backpack)
      .filter((item) => item.graphic === ingot && !item.hue)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const craftGump = () => [...session.world.gumps.values()].find((gump) => gump.layout.includes(String(SHIELDS)));

  // Ordinary tongs from the town smith, charged to the bank like any purchase.
  const ensureTool = async (backpack: number) => {
    if (carried(backpack).some((item) => smithTools.has(item.graphic))) return true;
    for (const shop of serviceLocations(city, 'blacksmith')) {
      await navigate(shop, 4);
      for (const mobile of [...session.world.entities.values()]) {
        if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
        const buy = (await session.context(mobile.serial).catch(() => [])).find(
          (e) => e.cliloc === 3006103 && !(e.flags & 1)
        );
        if (!buy) continue;
        await approachMobile(ctx, mobile.serial);
        const before = session.world.received.get(0x74) ?? 0;
        session.world.buyOffers.clear();
        session.selectContext(mobile.serial, buy.index);
        await session
          .waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'smith stock', 2500)
          .catch(() => {});
        const offer = [...session.world.buyOffers.values()]
          .flat()
          .find((entry) => tongs.has(session.world.entities.get(entry.serial)?.graphic ?? 0) && entry.price <= 30);
        if (!offer) continue;
        await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
          session.purchaseItem(mobile.serial, offer.serial, backpack, 1, 30)
        );
        log(`Bought smithing tongs for ${offer.price} gold`);
        return true;
      }
    }
    return false;
  };

  // A standing spot within two tiles of both an anvil and a forge (DefBlacksmithy range 2).
  const findSmithy = async () => {
    const statics = (ids: Set<number>) => terrain.findStatics(ids, position(), 200);
    const placed = (ids: Set<number>) =>
      [...session.world.entities.values()].flatMap((item) =>
        item.kind === 'item' && item.position && ids.has(item.graphic) ? [item.position] : []
      );
    const anvilSpots = [...placed(anvils), ...statics(anvils)];
    const forgeSpots = [...placed(forgeIds), ...statics(forgeIds)];
    const pairs = anvilSpots
      .flatMap((anvil) => forgeSpots.filter((forge) => distance(anvil, forge) <= 4).map((forge) => ({ anvil, forge })))
      .sort((a, b) => distance(position(), a.anvil) - distance(position(), b.anvil));
    for (const { anvil, forge } of pairs.slice(0, 6)) {
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 2; dy++) {
          const spot = terrain.stand(anvil.x + dx, anvil.y + dy, anvil.z);
          if (!spot || distance(spot, anvil) > 2 || distance(spot, forge) > 2) continue;
          if (await terrain.pathAsync(position(), spot, 0, ctx.blocked, spot.z, session.signal)) return spot;
        }
    }
    return undefined;
  };

  // Turns carried iron into the best-value item, keeping a remainder too small for one more.
  // Returns the serials crafted, ready to sell.
  const craft = async (backpack: number): Promise<Entity[]> => {
    const skill = session.world.skills.get(skillId('Blacksmith'))?.base ?? 0;
    const recipe = bestRecipe(skill);
    if (!recipe || recipe.perIngot <= RAW_INGOT_VALUE || iron(backpack) < recipe.ingots) return [];
    if (!(await ensureTool(backpack))) {
      log('No smithing tool available; selling raw ingots instead');
      return [];
    }
    const spot = await findSmithy();
    if (!spot) {
      log('No reachable anvil and forge pair; selling raw ingots instead');
      return [];
    }
    phase(
      'smithing',
      `Crafting ${recipe.name}s (${recipe.perIngot.toFixed(2)} gold per ingot vs ${RAW_INGOT_VALUE} raw)`
    );
    await navigate(spot, 0);
    const before = new Set(carried(backpack).map((item) => item.serial));
    let made = 0;
    for (let attempt = 0; attempt < 60 && iron(backpack) >= recipe.ingots; attempt++) {
      check();
      if (ctx.status().weight > ctx.status().maxWeight * 0.85) break;
      const tool = carried(backpack).find((item) => smithTools.has(item.graphic));
      if (!tool) break;
      if (!craftGump()) {
        session.use(tool.serial);
        await session.waitFor(() => !!craftGump(), 'blacksmithy menu', 4000);
      }
      let gump = craftGump();
      if (!gump) break;
      // Open the recipe's group when its item button is not on the current page.
      if (buttonFor(gump.layout, recipe.label) === undefined) {
        const group = buttonFor(gump.layout, recipe.group);
        if (group === undefined) break;
        const shown = session.world.received.get(gump.packed ? 0xdd : 0xb0) ?? 0;
        session.replyGump(gump.serial, gump.id, group, []);
        await session.waitFor(
          () => (session.world.received.get(gump?.packed ? 0xdd : 0xb0) ?? 0) > shown,
          'recipe group',
          4000
        );
        gump = craftGump();
      }
      const button = gump && buttonFor(gump.layout, recipe.label);
      if (!gump || button === undefined) break;
      const seen = new Set(session.world.journal);
      const prior = new Set(carried(backpack).map((item) => item.serial));
      const known = [...CREATED, ...FAILED, ...STOP];
      const menus = () => (session.world.received.get(0xdd) ?? 0) + (session.world.received.get(0xb0) ?? 0);
      const shown = menus();
      const notice = () => {
        if (menus() <= shown) return undefined;
        return gumpCommands(craftGump()?.layout ?? '')
          .filter((c) => c[0]?.startsWith('xmfhtml') && c[1] === '170' && c[2] === '295')
          .map((c) => Number(c[5]))
          .find((cliloc) => known.includes(cliloc));
      };
      const reply = () =>
        session.world.journal.find((e) => !seen.has(e) && known.includes(e.cliloc ?? 0))?.cliloc ?? notice();
      session.replyGump(gump.serial, gump.id, button, []);
      await session.waitFor(() => reply() !== undefined, 'crafting result', 8000);
      const result = reply() ?? 0;
      if (STOP.includes(result)) {
        log(`Smithing stopped by server reply ${result}`);
        break;
      }
      if (CREATED.includes(result)) {
        made++;
        tally(session, 'crafted');
      }
      await Bun.sleep(600);
      if (EXCEPTIONAL.includes(result)) {
        const piece = carried(backpack).filter((item) => !prior.has(item.serial) && item.graphic !== ingot);
        checkpoint.keep = [...(checkpoint.keep ?? []), ...piece.map((item) => item.serial)];
        log(`Exceptional ${recipe.name}; keeping it for the bank`);
      }
    }
    checkpoint.memories = [
      ...checkpoint.memories.slice(-49),
      { at: new Date().toISOString(), text: `Crafted ${made} ${recipe.name}s` }
    ];
    ctx.persist();
    return carried(backpack).filter(
      (item) =>
        !before.has(item.serial) &&
        item.graphic !== ingot &&
        !smithTools.has(item.graphic) &&
        !checkpoint.keep?.includes(item.serial)
    );
  };
  return { craft, iron };
}
