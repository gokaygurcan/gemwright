import { creatures, harvestTiles } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import {
  attack as attackPacket,
  contextMenu,
  dropGround,
  movementDeltas,
  sellItems,
  targetResponse,
  useItem,
  variable,
  walk as walkPacket
} from '@gemwright/network/packets';
import { Actions } from '@gemwright/network/replies';
import { WorldView } from '@gemwright/network/world';

import type { Terrain } from '../../src/terrain';
import {
  animation,
  characterStatus,
  combatTarget,
  containerContents,
  contextMenuData,
  damage as damagePacket,
  death,
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
const WRESTLING = skillId('Wrestling');
const TACTICS = skillId('Tactics');
const STOCK_SERIAL = 50;
const STOCK_CONTAINER = 60;
const PACK_SERIAL = 2;
const SELF_SERIAL = 1;
const VENDOR_SERIAL = 40;
const PICKAXE_SERIAL = 10;
const ORE_GRAPHIC = 6584;
const INGOT_GRAPHIC = 7154;
const GOLD_GRAPHIC = 3821;
const PICKAXE_GRAPHIC = 3718;
const PACK_GRAPHIC = 3701;
const FORGE_GRAPHIC = 4017;
const CORPSE_GRAPHIC = 0x2006;
// The town: the resident, a short seam, a forge, a smith who buys ingots and sells pickaxes.
const TOWN_MINE = { x: 104, y: 100, z: 0 };
const FORGE = { x: 102, y: 100, z: 0 };
const VENDOR = { x: 101, y: 100 };
const SEAM = 2;
// The frontier east of town: a rock face nobody has told it of, and the zombie camp the shard's
// word names. What is not in sight has not been sent to its client at all.
const FAR_MINE = { x: 140, y: 100, z: 0 };
const FAR_SEAM = 5;
const CAMP = { x: 152, y: 108, z: 0 };
const PICKAXE_PRICE = 25;
const PICKAXE_USES = 50;
const PREY_SERIAL = 45;
const CORPSE_SERIAL = 46;
const PREY_GOLD_SERIAL = 47;
export const ZOMBIE = creatures.find((creature) => creature.type === 'Zombie') as (typeof creatures)[number];

export interface FrontierOptions {
  // What it knows of itself when it wakes (skill values, by name).
  skills: Record<string, number>;
  // What it already carries.
  ore?: number;
}

// The region a resident wakes into: a town whose seam will not last the morning, a forge and a
// vendor, and — beyond anything its client has ever shown it — a second rock face and the camp the
// shard's word promises something at. The far ground answers no query until it has stood within
// sight of it, and the zombie there steps out when it comes near, as a spawner would have it.
export function startFrontier(options: FrontierOptions) {
  const world = new WorldView();
  world.connected = true;
  let sequence = 0;
  let cursors = 1;
  let ore = options.ore ?? 0;
  let ingots = 0;
  let gold = 0;
  let oreSerial = 0;
  let ingotSerial = 0;
  let goldSerial = 0;
  let nextSerial = 999;
  let tenths: Record<string, number> = Object.fromEntries(
    Object.entries(options.skills).map(([name, v]) => [name, Math.round(v * 10)])
  );
  let pickaxeUses = 0;
  let hasPickaxe = true;
  let digs = 0;
  let farDigs = 0;
  let townSeam = true;
  let farSeam = true;
  let revealed = false;
  let spawned = false;
  let selfHits = 100;
  const maxSelfHits = 100;
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
  };
  const teach = (skill: number, name: string, gain: number) => {
    if (tenths[name] === undefined) return;
    tenths = { ...tenths, [name]: tenths[name] + gain };
    world.apply(skillUpdate(skill, tenths[name] as number));
  };
  // What the far ground answers no query about until it has been seen: standing within sight of a
  // place is how a client comes to know it.
  const discover = () => {
    const here = world.position;
    if (!here) return;
    const away = (at: { x: number; y: number }) => Math.max(Math.abs(here.x - at.x), Math.abs(here.y - at.y));
    if (!revealed && away(FAR_MINE) <= 18) revealed = true;
    if (!spawned && away(CAMP) <= 15) {
      spawned = true;
      const listed = ZOMBIE.hits ?? [35, 35];
      const hits = Math.round(((listed[0] ?? 35) + (listed[1] ?? listed[0] ?? 35)) / 2);
      prey = { serial: PREY_SERIAL, hits, maxHits: hits, alive: true };
      world.apply(mobileIncoming(PREY_SERIAL, ZOMBIE.bodies[0] ?? 3, CAMP.x, CAMP.y, 0, 4));
      world.apply(nameReply(PREY_SERIAL, ZOMBIE.name ?? 'a zombie'));
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
      if (prey && serial === prey.serial) world.apply(nameReply(serial, ZOMBIE.name ?? 'a zombie'));
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
        world.apply(containerContents([{ serial: PREY_GOLD_SERIAL, graphic: GOLD_GRAPHIC, amount: 40 }], serial));
        return;
      }
      world.apply(targetCursor(cursors++));
    },
    replyGump() {},
    dig(at?: { x: number; y: number }) {
      if (!hasPickaxe) {
        world.apply(systemText('You have no pickaxe to dig with.'));
        return;
      }
      digs++;
      pickaxeUses++;
      if (pickaxeUses > PICKAXE_USES) {
        hasPickaxe = false;
        world.apply(removeEntity(PICKAXE_SERIAL));
        world.apply(systemText('Your pickaxe has broken!'));
        return;
      }
      // Both seams are short ones: after their few loads each gives nothing more.
      const spot = at ?? world.position ?? undefined;
      const far = spot !== undefined && Math.max(Math.abs(spot.x - FAR_MINE.x), Math.abs(spot.y - FAR_MINE.y)) <= 5;
      if (far) {
        farDigs++;
        if (farDigs > FAR_SEAM) farSeam = false;
      } else if (digs - farDigs > SEAM) townSeam = false;
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
      ingots += ore;
      ore = 0;
      teach(MINING, 'Mining', 1);
      repack();
      world.apply(systemText('You smelt the iron ore into ingots.'));
    },
    target(location: { serial: number; x: number; y: number; z: number; graphic: number } | null) {
      const active = world.target ?? { id: 0, ground: true, flags: 0, at: Date.now() };
      session.send(targetResponse(active, location));
      world.target = null;
      if (!location) return;
      if (location.serial === 0 && location.graphic === 0) session.dig(location);
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
      discover();
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
          offers.push({ serial: ingotSerial, graphic: INGOT_GRAPHIC, amount: ingots, price: 4, name: 'iron ingot' });
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
      }
      gold += paid;
      repack();
      world.apply(systemText(`You sell your goods for ${paid} gold.`));
    },
    async moveItem(serial: number, parent: number) {
      if (serial === PREY_GOLD_SERIAL) {
        gold += 40;
        world.apply(itemInContainer(PREY_GOLD_SERIAL, GOLD_GRAPHIC, 40, parent));
      }
    },
    async equipItem() {
      throw new Error('equipItem is not part of this scenario');
    },
    // The client attacking: the server names it the zombie's opponent and the exchange begins.
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
          world.apply(worldItem(CORPSE_SERIAL, CORPSE_GRAPHIC, CAMP.x, CAMP.y, 0));
          world.apply(combatTarget(0));
          world.apply(warMode(false));
          return;
        }
        world.apply(animation(serial, 6));
        world.apply(damagePacket(SELF_SERIAL, 3));
        selfHits = Math.max(1, selfHits - 3);
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
  world.apply(mobileIncoming(VENDOR_SERIAL, 400, VENDOR.x, VENDOR.y, 0, 6));
  repack();

  const terrain = {
    bestTiles: (
      tiles: { land: number[] },
      _at: unknown,
      score: (spot: { x: number; y: number; z: number; land: number }) => number
    ) => {
      if (!tiles.land.length) return [];
      const spots = [
        ...(townSeam ? [{ ...TOWN_MINE, land: ROCK }] : []),
        ...(revealed && farSeam ? [{ ...FAR_MINE, land: ROCK }] : [])
      ];
      return spots.filter((spot) => score(spot) > Number.NEGATIVE_INFINITY);
    },
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
    vendors: [{ ...VENDOR, range: 5, types: ['Blacksmith', 'Miner'] }]
  };

  return {
    session,
    world,
    terrain,
    places,
    landAt: (_x: number, _y: number, map: number | null) => (map === 1 ? ROCK : undefined),
    // The test observer putting the resident back in town between sessions.
    place: (x: number, y: number) => {
      if (world.position) world.position = { ...world.position, x, y };
    },
    // Between sessions the far seam seeps full again, as exhausted ground does over its respawn.
    regrow: () => {
      farSeam = true;
      farDigs = 0;
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
      farDigs,
      townSeam,
      farSeam,
      revealed,
      spawned,
      exchanges,
      selfHits,
      prey: prey ? { ...prey } : null
    })
  };
}

export type Frontier = ReturnType<typeof startFrontier>;
