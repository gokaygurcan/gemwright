import { creatures, harvestTiles } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import {
  attack as attackPacket,
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
  animation,
  characterStatus,
  combatTarget,
  containerContents,
  contextMenuData,
  damage as damagePacket,
  death,
  gump,
  hits as hitsPacket,
  itemInContainer,
  loginConfirm,
  mobileIncoming,
  nameReply,
  propertyList,
  removeEntity,
  sellList,
  skillUpdate,
  stockPrices,
  swing,
  systemText,
  targetCursor,
  warMode,
  worldItem
} from './shard-packets';

export const ROCK = harvestTiles.rock.land[0] as number;
const MINING = skillId('Mining');
const BLACKSMITH = skillId('Blacksmith');
const WRESTLING = skillId('Wrestling');
const TACTICS = skillId('Tactics');
const STOCK_SERIAL = 50;
const STOCK_CONTAINER = 60;
const PACK_SERIAL = 2;
const SELF_SERIAL = 1;
const VENDOR_SERIAL = 40;
const PICKAXE_SERIAL = 10;
const HAMMER_SERIAL = 11;
const ORE_GRAPHIC = 6584;
const INGOT_GRAPHIC = 7154;
const GOLD_GRAPHIC = 3821;
const PICKAXE_GRAPHIC = 3718;
const PACK_GRAPHIC = 3701;
const FORGE_GRAPHIC = 4017;
const CORPSE_GRAPHIC = 0x2006;
const MINE = { x: 108, y: 100, z: 0 };
const FORGE = { x: 103, y: 100, z: 0 };
const VENDOR = { x: 104, y: 100 };
const PICKAXE_PRICE = 25;
const PICKAXE_USES = 8;
const ANVIL_SERIAL = 70;
const ANVIL_GRAPHIC = 4015;
const PREY_SERIAL = 45;
const PREY_AT = { x: 110, y: 99 };
const CORPSE_SERIAL = 46;
const PREY_GOLD_SERIAL = 47;
// What seeps out of the rock face: a small thing, and no pay in it worth the name.
export const OOZE = creatures.find((creature) => creature.type === 'FrostOoze') as (typeof creatures)[number];

// The valley a resident lives in: a rock face it can mine, a forge and an anvil, a smith's shop that
// buys ingots and work and sells pickaxes, a beast that can arrive at any moment, and the woods. The
// wilds beyond hold whatever it remembers; the shard only keeps what happens where it stands.
export interface ValleyOptions {
  // What it knows of itself when it wakes (skill values, by name).
  skills: Record<string, number>;
  // What it already carries: the yield of the life that brought it here.
  ore?: number;
  ingots?: number;
  // The smith's hammer and the recipe its menu works (a blacksmith's, when it has one).
  hammer?: boolean;
  recipe?: {
    gump: number;
    button: number;
    itemType: string;
    itemGraphic: number;
    price: number;
    ingotsPerCraft: number;
  };
}
const DEFAULT_RECIPE = {
  gump: 42,
  button: 21,
  itemType: 'StuddedChest',
  itemGraphic: 5083,
  price: 90,
  ingotsPerCraft: 5
};

export function startValley(options: ValleyOptions) {
  const world = new WorldView();
  world.connected = true;
  const recipe = options.recipe ?? DEFAULT_RECIPE;
  let sequence = 0;
  let cursors = 1;
  let ore = options.ore ?? 0;
  let ingots = options.ingots ?? 0;
  let gold = 0;
  let oreSerial = 0;
  let ingotSerial = 0;
  let goldSerial = 0;
  let craftSerial = 0;
  let nextSerial = 999;
  let tenths: Record<string, number> = Object.fromEntries(
    Object.entries(options.skills).map(([name, v]) => [name, Math.round(v * 10)])
  );
  let pickaxeUses = 0;
  let hasPickaxe = true;
  let offers = true;
  let digs = 0;
  let breaks = 0;
  let smelts = 0;
  let crafts = 0;
  let created = 0;
  let sold = 0;
  let bought = 0;
  let selfHits = 100;
  const maxSelfHits = 100;
  // The beast: not here until it wanders in.
  let prey: { serial: number; hits: number; maxHits: number; alive: boolean } | undefined;
  let exchanges = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const repack = () => {
    if (ore > 0) {
      if (!oreSerial) oreSerial = ++nextSerial;
      world.apply(itemInContainer(oreSerial, ORE_GRAPHIC, ore, PACK_SERIAL));
    } else if (oreSerial) world.apply(removeEntity(oreSerial));
    if (ingots > 0) {
      if (!ingotSerial) ingotSerial = ++nextSerial;
      world.apply(itemInContainer(ingotSerial, INGOT_GRAPHIC, ingots, PACK_SERIAL));
    } else if (ingotSerial) world.apply(removeEntity(ingotSerial));
    if (gold > 0) {
      if (!goldSerial) goldSerial = ++nextSerial;
      world.apply(itemInContainer(goldSerial, GOLD_GRAPHIC, gold, PACK_SERIAL));
    } else if (goldSerial) world.apply(removeEntity(goldSerial));
    if (created > 0) {
      if (!craftSerial) craftSerial = ++nextSerial;
      world.apply(itemInContainer(craftSerial, recipe.itemGraphic, created, PACK_SERIAL));
    } else if (craftSerial) {
      world.apply(removeEntity(craftSerial));
      craftSerial = 0;
    }
  };
  const teach = (skill: number, name: string, gain: number) => {
    if (tenths[name] === undefined) return;
    tenths = { ...tenths, [name]: tenths[name] + gain };
    world.apply(skillUpdate(skill, tenths[name] as number));
  };

  const session = {
    world,
    phase: 'ready' as const,
    tap: undefined as ((direction: 'in' | 'out', packet: Buffer) => void) | undefined,
    send(packet: Buffer) {
      session.tap?.('out', packet);
    },
    async refreshSkills() {
      const entries = Object.entries(options.skills).map(([name, value]) => ({ id: skillId(name), value }));
      const body = Buffer.alloc(1 + entries.length * 9 + 2);
      body[0] = 2;
      entries.forEach((entry, index) => {
        const at = 1 + index * 9;
        body.writeUInt16BE(entry.id + 1, at);
        body.writeUInt16BE(entry.value * 10, at + 2);
        body.writeUInt16BE(entry.value * 10, at + 4);
        body[at + 6] = 0;
        body.writeUInt16BE(1000, at + 7);
      });
      world.apply(variable(0x3a, body));
    },
    async inspectProperties(serial: number) {
      const amount = serial === oreSerial ? ore : serial === ingotSerial ? ingots : serial === goldSerial ? gold : 1;
      world.apply(propertyList(serial, 1072788, String(Math.max(1, amount) * 2)));
    },
    requestName(serial: number) {
      if (prey && serial === prey.serial) world.apply(nameReply(serial, OOZE.name ?? 'a frost ooze'));
      else if (world.entities.has(serial)) world.apply(nameReply(serial, 'a blacksmith'));
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
      if (serial === CORPSE_SERIAL) {
        world.apply(containerContents([{ serial: PREY_GOLD_SERIAL, graphic: GOLD_GRAPHIC, amount: 3 }], serial));
        return;
      }
      if (options.hammer && serial === HAMMER_SERIAL) {
        world.apply(gump(HAMMER_SERIAL, recipe.gump, `{ button 40 60 4005 4007 1 0 ${recipe.button} }`));
        return;
      }
      world.apply(targetCursor(cursors++));
    },
    replyGump(serial: number, id: number, button: number) {
      session.send(gumpReply(serial, id, button, [], []));
      world.gumps.delete(`${serial}:${id}`);
      if (id === recipe.gump && button === recipe.button) session.craft();
    },
    dig() {
      if (!hasPickaxe) {
        world.apply(systemText('You have no pickaxe to dig with.'));
        return;
      }
      digs++;
      pickaxeUses++;
      if (pickaxeUses > PICKAXE_USES) {
        hasPickaxe = false;
        breaks++;
        world.apply(removeEntity(PICKAXE_SERIAL));
        world.apply(systemText('Your pickaxe has broken!'));
        return;
      }
      ore++;
      teach(MINING, 'Mining', 1);
      if (!oreSerial) oreSerial = ++nextSerial;
      world.apply(itemInContainer(oreSerial, ORE_GRAPHIC, ore, PACK_SERIAL));
      world.apply(systemText('You dig some iron ore out of the ground.'));
    },
    smelt() {
      if (ore <= 0) {
        world.apply(systemText('There is no ore to smelt.'));
        return;
      }
      smelts++;
      ingots += ore;
      ore = 0;
      teach(MINING, 'Mining', 1);
      repack();
      world.apply(systemText('You smelt the iron ore into ingots.'));
    },
    // The smith's attempt its client makes: the hammer on a button of its menu.
    craft() {
      crafts++;
      if (ingots < recipe.ingotsPerCraft) {
        world.apply(systemText('You have not enough ingots to work with.'));
        return;
      }
      ingots -= recipe.ingotsPerCraft;
      created++;
      teach(BLACKSMITH, 'Blacksmith', 1);
      repack();
      world.apply(systemText(`You smith a ${recipe.itemType.toLowerCase()}.`));
    },
    target(location: { serial: number; x: number; y: number; z: number; graphic: number } | null) {
      const active = world.target ?? { id: 0, ground: true, flags: 0, at: Date.now() };
      session.send(targetResponse(active, location));
      world.target = null;
      if (!location) return;
      if (location.serial === 0 && location.graphic === 0) session.dig();
      else if (location.graphic === FORGE_GRAPHIC) session.smelt();
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
            price: 4,
            name: 'iron ingot'
          });
        if (created > 0)
          offers.push({
            serial: craftSerial,
            graphic: recipe.itemGraphic,
            amount: created,
            price: recipe.price,
            name: recipe.itemType.toLowerCase()
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
      bought++;
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
          paid += amount * 4;
        }
        if (item.serial === craftSerial) {
          const amount = Math.min(item.amount, created);
          created -= amount;
          paid += amount * recipe.price;
        }
      }
      gold += paid;
      sold++;
      repack();
      world.apply(systemText(`You sell your goods for ${paid} gold.`));
    },
    async moveItem(serial: number, parent: number) {
      if (serial === PREY_GOLD_SERIAL) {
        gold += 3;
        world.apply(itemInContainer(PREY_GOLD_SERIAL, GOLD_GRAPHIC, 3, parent));
      }
    },
    async equipItem() {
      throw new Error('equipItem is not part of this scenario');
    },
    // The client attacking: the server names it the beast's opponent and the exchange begins. Blows
    // land until one side falls; the shard answers the first swing of each with what happened.
    async attack(serial: number) {
      session.send(attackPacket(serial));
      world.apply(combatTarget(serial));
      if (!world.warMode) world.apply(warMode(true));
      if (!prey || prey.serial !== serial || !prey.alive || timer) return;
      timer = setInterval(() => {
        if (!prey?.alive) return;
        exchanges++;
        world.apply(swing(SELF_SERIAL, serial));
        world.apply(damagePacket(serial, 10));
        prey.hits = Math.max(0, prey.hits - 10);
        world.apply(hitsPacket(serial, prey.maxHits, prey.hits));
        teach(WRESTLING, 'Wrestling', 1);
        teach(TACTICS, 'Tactics', 1);
        if (prey.hits <= 0) {
          prey.alive = false;
          if (timer) clearInterval(timer);
          timer = undefined;
          world.apply(death(serial, CORPSE_SERIAL));
          world.apply(removeEntity(serial));
          world.apply(worldItem(CORPSE_SERIAL, CORPSE_GRAPHIC, PREY_AT.x, PREY_AT.y, 0));
          world.apply(combatTarget(0));
          world.apply(warMode(false));
          return;
        }
        world.apply(animation(serial, 6));
        world.apply(damagePacket(SELF_SERIAL, 2));
        selfHits = Math.max(1, selfHits - 2);
        world.apply(hitsPacket(SELF_SERIAL, maxSelfHits, selfHits));
      }, 1200);
    },
    setWarMode(enabled: boolean) {
      world.apply(warMode(enabled));
    }
  };

  world.apply(loginConfirm(SELF_SERIAL, 100, 100, 0, 2));
  world.apply(variable(0xbf, Buffer.from([0x00, 0x08, 0x01])));
  world.apply(
    mobileIncoming(SELF_SERIAL, 400, 100, 100, 0, 2, [
      { serial: PACK_SERIAL, graphic: PACK_GRAPHIC, layer: Layer.Backpack }
    ])
  );
  world.apply(
    characterStatus(SELF_SERIAL, { name: 'Resident', hits: selfHits, maxHits: maxSelfHits, weight: 60, maxWeight: 550 })
  );
  if (hasPickaxe) world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
  if (options.hammer) {
    world.apply(itemInContainer(HAMMER_SERIAL, 5091, 1, PACK_SERIAL));
    world.apply(worldItem(ANVIL_SERIAL, ANVIL_GRAPHIC, 105, 100, 0));
  }
  world.apply(mobileIncoming(VENDOR_SERIAL, 400, VENDOR.x, VENDOR.y, 0, 6));
  repack();

  const terrain = {
    bestTiles: (
      tiles: { land: number[] },
      _at: unknown,
      score: (spot: { x: number; y: number; z: number; land: number }) => number
    ) =>
      offers && tiles.land.length
        ? [{ ...MINE, land: ROCK }].filter((spot) => score(spot) > Number.NEGATIVE_INFINITY)
        : [],
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
    vendors: [{ ...VENDOR, range: 5, types: ['Blacksmith', 'Armorer', 'Miner'] }]
  };

  return {
    session,
    world,
    terrain,
    places,
    landAt: (_x: number, _y: number, map: number | null) => (map === 1 ? ROCK : undefined),
    // The beast wanders in at a moment of the observer's choosing, its name arriving with it (as the
    // client's own All Names would have it).
    spawnPrey: () => {
      if (prey) return;
      const listed = OOZE.hits ?? [18, 18];
      const hits = Math.round(((listed[0] ?? 18) + (listed[1] ?? listed[0] ?? 18)) / 2);
      prey = { serial: PREY_SERIAL, hits, maxHits: hits, alive: true };
      world.apply(mobileIncoming(PREY_SERIAL, OOZE.bodies[0] ?? 52, PREY_AT.x, PREY_AT.y, 0, 4));
      world.apply(nameReply(PREY_SERIAL, OOZE.name ?? 'a frost ooze'));
    },
    // The seam runs dry: the rock face stops giving.
    exhaust: () => {
      offers = false;
    },
    // Between lives, the observer sets out a fresh tool and the pile of ore the last life left it.
    restock: (pile: number) => {
      ore = pile;
      hasPickaxe = true;
      pickaxeUses = 0;
      world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
      repack();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state: () => ({
      ore,
      ingots,
      gold,
      digs,
      breaks,
      smelts,
      crafts,
      created,
      sold,
      bought,
      exchanges,
      selfHits,
      prey: prey ? { ...prey } : null
    })
  };
}

export type Valley = ReturnType<typeof startValley>;
