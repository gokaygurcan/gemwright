import { harvestTiles } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import {
  contextMenu,
  dropGround,
  gumpReply,
  movementDeltas,
  sellItems,
  targetResponse,
  useItem,
  variable,
  walk as walkPacket
} from '@gemwright/network/packets';
import { Actions } from '@gemwright/network/replies';
import { WorldView } from '@gemwright/network/world';

import type { Terrain } from '../../../src/terrain';
import {
  containerContents,
  contextMenuData,
  gump,
  itemInContainer,
  loginConfirm,
  mobileIncoming,
  propertyList,
  removeEntity,
  sellList,
  skillUpdate,
  stockPrices,
  systemText,
  targetCursor,
  worldItem
} from './shard-packets';

export const ROCK = harvestTiles.rock.land[0] as number;
const MINING = skillId('Mining');
const BLACKSMITH = skillId('Blacksmith');
const STOCK_SERIAL = 50;
const STOCK_CONTAINER = 60;
const PACK_SERIAL = 2;
const SELF_SERIAL = 1;
const VENDOR_SERIAL = 40;
export const PICKAXE_SERIAL = 10;
export const HAMMER_SERIAL = 11;
const ORE_GRAPHIC = 6584;
const INGOT_GRAPHIC = 7154;
const GOLD_GRAPHIC = 3821;
const PICKAXE_GRAPHIC = 3718;
const PACK_GRAPHIC = 3701;
const FORGE_GRAPHIC = 4017;
const MINE = { x: 108, y: 100, z: 0 };
const FORGE = { x: 103, y: 100, z: 0 };
const VENDOR = { x: 104, y: 100 };
const PICKAXE_PRICE = 25;
const PICKAXE_USES = 8;
const ANVIL_SERIAL = 70;
export const ANVIL_GRAPHIC = 4015;

// What the shard offers beyond the basic chain: the tools and station of a blacksmith, the menus
// the hammer opens, the recipe behind them, and what it pays for the goods.
export interface MenuButton {
  button: number;
  // The menu this button opens (a category or a way back), or the recipe it works, and its cost in
  // ingots (the trade's usual recipe cost when not given).
  opens?: number;
  crafts?: boolean;
  ingots?: number;
}
export interface Menu {
  id: number;
  buttons: MenuButton[];
}
export interface Blacksmithing {
  anvil: { x: number; y: number; z: number };
  hammer: number;
  // The menus the hammer's use opens (the first is the root), with their buttons; without them, a
  // single menu of one recipe button.
  menus?: Menu[];
  gump?: number;
  button?: number;
  itemType: string;
  itemGraphic: number;
  itemPrice: number;
  ingotsPerCraft: number;
  // The success of each craft attempt in turn (the last repeats): a shard's skill checks.
  successes: boolean[];
  hammerUses: number;
  skillGainTenths: number;
}
export interface ShardOptions {
  // The forge goes cold after the first sale (the production-chain experiment's disagreement).
  coldAfterFirstSale?: boolean;
  // What the vendor pays per ingot sold.
  ingotPrice?: number;
  // The vendor types the shard places (what it sells and buys, from the rules).
  vendors?: string[];
  blacksmithing?: Blacksmithing;
}

// The shard a resident lives on: it answers every client verb with the packets a real shard would
// send, applied straight to the world view. Its pickaxe wears out after eight digs, its vendor
// (a smith and a miner's goods) sells fresh ones and buys ingots, and by default its forge goes
// cold after the first sale: the disagreement the production-chain mind must revise around.
export function startShard(options: ShardOptions = {}) {
  const world = new WorldView();
  world.connected = true;
  const ingotPrice = options.ingotPrice ?? 4;
  const coldAfterFirstSale = options.coldAfterFirstSale ?? true;
  const smith = options.blacksmithing;
  // The trade menus the hammer opens, and the recipes behind their buttons.
  const menus: Menu[] = smith
    ? (smith.menus ?? [{ id: smith.gump ?? 0, buttons: [{ button: smith.button ?? 0, crafts: true }] }])
    : [];
  const menuLayout = (menu: Menu) =>
    `{ resizepic 0 0 5054 260 180 }{ text 30 20 0 0 }${menu.buttons
      .map((entry, index) => `{ button 40 ${60 + index * 24} 4005 4007 1 0 ${entry.button} }`)
      .join('')}`;
  const openMenu = (menu: Menu) => {
    for (const key of [...world.gumps.keys()]) if (key.startsWith(`${HAMMER_SERIAL}:`)) world.gumps.delete(key);
    world.apply(gump(HAMMER_SERIAL, menu.id, menuLayout(menu)));
  };
  let sequence = 0;
  let cursors = 1;
  let ore = 0;
  let ingots = 0;
  let gold = 0;
  let oreSerial = 0;
  let ingotSerial = 0;
  let goldSerial = 0;
  let nextSerial = 999;
  let miningTenths = 750;
  // A smith knows some smithing: a hammer is tried only in a craft one has skill in.
  let blacksmithTenths = smith ? 300 : 0;
  let pickaxeUses = 0;
  let hasPickaxe = true;
  let cold = false;
  let sales = 0;
  let breaks = 0;
  let purchases = 0;
  let craftAttempts = 0;
  let crafted = 0;
  let ingotsSoldRaw = 0;
  let craftSerial = 0;
  let hammerUsesLeft = smith?.hammerUses ?? 0;
  // What the vendor pays for the crafted work; a shop's price can change over a resident's life.
  let itemPrice = smith?.itemPrice ?? 0;

  const repack = () => {
    if (ore > 0) world.apply(itemInContainer(oreSerial, ORE_GRAPHIC, ore, PACK_SERIAL));
    else if (oreSerial) world.apply(removeEntity(oreSerial));
    if (ingots > 0) world.apply(itemInContainer(ingotSerial, INGOT_GRAPHIC, ingots, PACK_SERIAL));
    else if (ingotSerial) world.apply(removeEntity(ingotSerial));
    if (gold > 0) world.apply(itemInContainer(goldSerial, GOLD_GRAPHIC, gold, PACK_SERIAL));
    else if (goldSerial) world.apply(removeEntity(goldSerial));
    if (crafted > 0 && craftSerial)
      world.apply(itemInContainer(craftSerial, smith?.itemGraphic ?? 0, crafted, PACK_SERIAL));
    else if (craftSerial) {
      world.apply(removeEntity(craftSerial));
      craftSerial = 0;
    }
  };

  const session = {
    world,
    phase: 'ready' as const,
    tap: undefined as ((direction: 'in' | 'out', packet: Buffer) => void) | undefined,
    send(packet: Buffer) {
      session.tap?.('out', packet);
    },
    async refreshSkills() {
      const known = [[MINING, miningTenths], ...(smith ? [[BLACKSMITH, blacksmithTenths]] : [])];
      const body = Buffer.alloc(3 + known.length * 9);
      body[0] = 2;
      known.forEach(([id, tenths], index) => {
        const at = 1 + index * 9;
        body.writeUInt16BE((id ?? 0) + 1, at);
        body.writeUInt16BE(tenths ?? 0, at + 2);
        body.writeUInt16BE(tenths ?? 0, at + 4);
        body.writeUInt16BE(1000, at + 7);
      });
      world.apply(variable(0x3a, body));
    },
    async inspectProperties(serial: number) {
      const amount = serial === oreSerial ? ore : serial === ingotSerial ? ingots : serial === goldSerial ? gold : 1;
      world.apply(propertyList(serial, 1072788, String(Math.max(1, amount) * 2)));
    },
    requestName(serial: number) {
      if (!world.entities.has(serial)) return;
      const packet = Buffer.alloc(37);
      packet[0] = 0x98;
      packet.writeUInt16BE(37, 1);
      packet.writeUInt32BE(serial, 3);
      packet.write('a blacksmith', 7, 'ascii');
      world.apply(packet);
    },
    async resyncPosition() {
      return true;
    },
    async dropAtFeet(serial: number) {
      const position = world.position;
      if (!position) return;
      session.send(dropGround(serial, position.x, position.y, position.z));
      if (serial === oreSerial) ore = 0;
      else if (serial === ingotSerial) ingots = 0;
      else if (serial === goldSerial) gold = 0;
      world.apply(removeEntity(serial));
    },
    use(serial: number) {
      session.send(useItem(serial));
      const entity = world.entities.get(serial);
      if (entity?.layer === Layer.Backpack) {
        const entries = [...world.entities.values()]
          .filter((item) => item.parent === serial)
          .map((item) => ({ serial: item.serial, graphic: item.graphic ?? 0, amount: item.amount ?? 1 }));
        world.apply(containerContents(entries, serial));
        return;
      }
      if (smith && serial === HAMMER_SERIAL) {
        // The smith's hammer opens its trade menu, as ServUO's craft tools do.
        const root = menus[0];
        if (root) openMenu(root);
        return;
      }
      world.apply(targetCursor(cursors++));
    },
    replyGump(serial: number, id: number, button: number) {
      session.send(gumpReply(serial, id, button, [], []));
      world.gumps.delete(`${serial}:${id}`);
      const entry = menus.find((menu) => menu.id === id)?.buttons.find((candidate) => candidate.button === button);
      if (entry?.crafts) session.craft(entry.ingots);
      else if (entry?.opens !== undefined) {
        const opened = menus.find((menu) => menu.id === entry.opens);
        if (opened) openMenu(opened);
      }
    },
    dig() {
      if (!hasPickaxe) {
        world.apply(systemText('You have no pickaxe to dig with.'));
        return;
      }
      pickaxeUses++;
      if (pickaxeUses > PICKAXE_USES) {
        hasPickaxe = false;
        breaks++;
        world.apply(removeEntity(PICKAXE_SERIAL));
        world.apply(systemText('Your pickaxe has broken!'));
        return;
      }
      if (ore === 0) oreSerial = ++nextSerial;
      ore++;
      miningTenths++;
      world.apply(itemInContainer(oreSerial, ORE_GRAPHIC, ore, PACK_SERIAL));
      world.apply(skillUpdate(MINING, miningTenths));
      world.apply(systemText('You dig some iron ore out of the ground.'));
    },
    smelt() {
      if (ore <= 0) {
        world.apply(systemText('There is no ore to smelt.'));
        return;
      }
      const amount = ore;
      if (cold) {
        // The forge takes the ore and gives nothing back: half burns away in the coals.
        ore = amount - Math.ceil(amount / 2);
        repack();
        world.apply(systemText('The forge takes the ore, and the metal is lost in the coals.'));
        return;
      }
      ore = 0;
      if (ingots === 0) ingotSerial = ++nextSerial;
      ingots += amount;
      miningTenths++;
      repack();
      world.apply(skillUpdate(MINING, miningTenths));
      world.apply(systemText('You smelt the iron ore into ingots.'));
    },
    // The blacksmith's attempt its client makes: the hammer on the anvil. Each attempt uses ingots,
    // risks losing them, may bring the work, trains the skill and wears the hammer out.
    craft(cost?: number) {
      if (!smith) return;
      craftAttempts++;
      const used = cost ?? smith.ingotsPerCraft;
      if (ingots < used) {
        world.apply(systemText('You have not enough ingots to work with.'));
        return;
      }
      ingots -= used;
      const success = smith.successes[Math.min(craftAttempts - 1, smith.successes.length - 1)] ?? false;
      if (success) {
        crafted++;
        if (craftSerial === 0) craftSerial = ++nextSerial;
        repack();
        world.apply(itemInContainer(craftSerial, smith.itemGraphic, crafted, PACK_SERIAL));
        world.apply(systemText(`You smith a ${smith.itemType.toLowerCase()}.`));
      } else {
        repack();
        world.apply(systemText('Your smithing fails, and the ingots are lost in the work.'));
      }
      blacksmithTenths += smith.skillGainTenths;
      world.apply(skillUpdate(BLACKSMITH, blacksmithTenths));
      hammerUsesLeft--;
      if (hammerUsesLeft <= 0) {
        world.apply(removeEntity(HAMMER_SERIAL));
        world.apply(systemText("Your smith's hammer has broken!"));
      }
    },
    target(location: { serial: number; x: number; y: number; z: number; graphic: number } | null) {
      const active = world.target ?? { id: 0, ground: true, flags: 0, at: Date.now() };
      session.send(targetResponse(active, location));
      world.target = null;
      if (!location) return;
      if (location.serial === 0 && location.graphic === 0) session.dig();
      else if (location.graphic === FORGE_GRAPHIC) session.smelt();
      else if (smith && location.graphic === ANVIL_GRAPHIC) session.craft();
    },
    async walk(direction: number, z?: number, running = false) {
      const position = world.position;
      if (!position) return false;
      const step = sequence++;
      session.send(walkPacket(direction, step & 0xff, running));
      const turning = position.direction !== direction;
      if (turning) world.position = { ...position, direction };
      else {
        const delta = movementDeltas[direction];
        if (!delta) return false;
        world.position = { x: position.x + delta[0], y: position.y + delta[1], z: z ?? position.z, direction };
      }
      await Bun.sleep(turning ? 25 : 400);
      world.apply(Buffer.from([0x22, step & 0xff, 1]));
      return true;
    },
    say(text: string) {
      session.send(variable(0xad, Buffer.from(`\x00${text}\0`, 'latin1')));
    },
    emote() {},
    async context(serial: number) {
      session.send(contextMenu(serial));
      world.apply(
        contextMenuData(serial, [
          { cliloc: Actions.buy, index: 1 },
          { cliloc: Actions.sell, index: 2 }
        ])
      );
      return world.contextMenus.get(serial) ?? [];
    },
    selectContext(serial: number, index: number) {
      session.send(contextMenu(serial, index));
      if (index === 2) {
        const offers: { serial: number; graphic: number; amount: number; price: number; name: string }[] = [];
        if (ingots > 0)
          offers.push({
            serial: ingotSerial,
            graphic: INGOT_GRAPHIC,
            amount: ingots,
            price: ingotPrice,
            name: 'iron ingot'
          });
        if (smith && crafted > 0)
          offers.push({
            serial: craftSerial,
            graphic: smith.itemGraphic,
            amount: crafted,
            price: itemPrice,
            name: smith.itemType.toLowerCase()
          });
        if (offers.length) world.apply(sellList(serial, offers));
      }
      if (index === 1) {
        world.apply(
          containerContents([{ serial: STOCK_SERIAL, graphic: PICKAXE_GRAPHIC, amount: 1 }], STOCK_CONTAINER)
        );
        world.apply(stockPrices(STOCK_CONTAINER, PICKAXE_PRICE));
      }
    },
    async purchaseItem(_vendor: number, _serial: number, _pack: number, _amount: number, price: number) {
      gold -= price;
      purchases++;
      hasPickaxe = true;
      pickaxeUses = 0;
      repack();
      world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
      world.apply(systemText(`You buy a pickaxe for ${price} gold.`));
    },
    async sell(vendor: number, items: { serial: number; amount: number }[]) {
      session.send(sellItems(vendor, items));
      let paid = 0;
      for (const item of items) {
        if (item.serial === ingotSerial) {
          const amount = Math.min(item.amount, ingots);
          ingots -= amount;
          paid += amount * ingotPrice;
          ingotsSoldRaw += amount;
        }
        if (smith && item.serial === craftSerial) {
          const amount = Math.min(item.amount, crafted);
          crafted -= amount;
          paid += amount * itemPrice;
        }
      }
      if (gold === 0) goldSerial = ++nextSerial;
      gold += paid;
      repack();
      world.apply(systemText(`You sell your goods for ${paid} gold.`));
      sales++;
      if (coldAfterFirstSale && !cold && sales >= 1) cold = true;
    },
    async moveItem() {
      throw new Error('moveItem is not part of this scenario');
    },
    async equipItem() {
      throw new Error('equipItem is not part of this scenario');
    },
    async attack() {
      throw new Error('attack is not part of this scenario');
    },
    setWarMode() {
      throw new Error('setWarMode is not part of this scenario');
    }
  };

  world.apply(loginConfirm(SELF_SERIAL, 100, 100, 0, 2));
  world.apply(variable(0xbf, Buffer.from([0x00, 0x08, 0x01])));
  world.apply(
    mobileIncoming(SELF_SERIAL, 400, 100, 100, 0, 2, [
      { serial: PACK_SERIAL, graphic: PACK_GRAPHIC, layer: Layer.Backpack }
    ])
  );
  world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
  if (smith) {
    world.apply(itemInContainer(HAMMER_SERIAL, smith.hammer, 1, PACK_SERIAL));
    world.apply(worldItem(ANVIL_SERIAL, ANVIL_GRAPHIC, smith.anvil.x, smith.anvil.y, smith.anvil.z));
  }
  world.apply(mobileIncoming(VENDOR_SERIAL, 400, VENDOR.x, VENDOR.y, 0, 6));
  world.skills.set(MINING, { value: 75, base: 75, cap: 100, lock: 0 });
  if (smith)
    world.skills.set(BLACKSMITH, { value: blacksmithTenths / 10, base: blacksmithTenths / 10, cap: 100, lock: 0 });

  const terrain = {
    bestTiles: (
      tiles: { land: number[] },
      _at: unknown,
      score: (spot: { x: number; y: number; z: number; land: number }) => number
    ) => (tiles.land.length ? [{ ...MINE, land: ROCK }].filter((spot) => score(spot) > Number.NEGATIVE_INFINITY) : []),
    findTiles: () => [],
    tile: () => ({ flags: 0, height: 0, layer: 0 }),
    sight: () => true,
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: ROCK }, statics: [] }),
    pathAsync: async (from: { x: number; y: number; z: number }, goal: { x: number; y: number }, range: number) => {
      const path: { x: number; y: number; z: number }[] = [];
      let { x, y } = from;
      while (Math.max(Math.abs(goal.x - x), Math.abs(goal.y - y)) > range) {
        if (goal.x !== x) x += Math.sign(goal.x - x);
        else if (goal.y !== y) y += Math.sign(goal.y - y);
        path.push({ x, y, z: from.z });
      }
      return path;
    }
  } as unknown as Terrain;

  const places = {
    shrines: [],
    bankers: [],
    forges: [{ ...FORGE, id: FORGE_GRAPHIC }],
    vendors: [{ ...VENDOR, range: 5, types: options.vendors ?? ['Blacksmith', 'Miner'] }]
  };

  return {
    session,
    world,
    terrain,
    places,
    landAt: (_x: number, _y: number, map: number | null) => (map === 1 ? ROCK : undefined),
    // The shop changes what it pays for the work, as a market does.
    price: (value: number) => {
      itemPrice = value;
    },
    // The observer sets out a fresh tool and a pile of ore, so the moment it is watching is about
    // what the resident makes of the market, not whether it happens to have a pick.
    restock: (pile: number) => {
      ore = pile;
      hasPickaxe = true;
      pickaxeUses = 0;
      world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
      repack();
    },
    state: () => ({
      ore,
      ingots,
      gold,
      cold,
      sales,
      breaks,
      purchases,
      craftAttempts,
      crafted,
      ingotsSoldRaw,
      hammerUses: hammerUsesLeft,
      ingotPrice,
      itemPrice,
      recipe: smith ?? null
    })
  };
}

export type Shard = ReturnType<typeof startShard>;
