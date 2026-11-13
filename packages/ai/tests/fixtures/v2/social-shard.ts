import { harvestTiles } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import {
  contextMenu,
  dropGround,
  gumpReply,
  movementDeltas,
  targetResponse,
  useItem,
  variable,
  walk as walkPacket
} from '@gemwright/network/packets';
import { Actions } from '@gemwright/network/replies';
import { WorldView } from '@gemwright/network/world';

import type { Terrain } from '../../../src/terrain';
import {
  characterStatus,
  containerContents,
  contextMenuData,
  gump,
  itemInContainer,
  loginConfirm,
  mobileIncoming,
  nameReply,
  propertyList,
  removeEntity,
  skillUpdate,
  speech,
  systemText,
  targetCursor,
  worldItem
} from './shard-packets';

export const ROCK = harvestTiles.rock.land[0] as number;
const MINING = skillId('Mining');
const PACK_SERIAL = 2;
const SELF_SERIAL = 1;
const PICKAXE_SERIAL = 10;
const ORE_GRAPHIC = 6584;
const INGOT_GRAPHIC = 7154;
const GOLD_GRAPHIC = 3821;
const PICKAXE_GRAPHIC = 3718;
const PACK_GRAPHIC = 3701;
const FORGE_GRAPHIC = 4017;
const MINE = { x: 104, y: 100, z: 0 };
const FORGE = { x: 102, y: 100, z: 0 };
const SEAM = 3;
// The other player, standing by the road: a person is a Person, and she is Marcy.
export const MARCY_SERIAL = 41;
const MARCY = { x: 107, y: 100 };
const MARCY_GUMP = 7;
const MARCY_SAYS = {
  greet: 'Well met, traveller.',
  gift: 'Here, a few coins for the road.',
  spent: 'I have nothing more for you today.'
};

export interface SocialOptions {
  skills: Record<string, number>;
}

// A corner of the world with one seam in it, a forge, and one other player standing where the road
// passes. Nothing prescribes what may come of meeting her: what she answers, whether it is worth
// anything, and what the resident makes of her is all learned, as with any tool's menu.
export function startSocial(options: SocialOptions) {
  const world = new WorldView();
  world.connected = true;
  let sequence = 0;
  let cursors = 1;
  let ore = 0;
  let ingots = 0;
  let gold = 0;
  let oreSerial = 0;
  let ingotSerial = 0;
  let goldSerial = 0;
  let nextSerial = 999;
  let tenths: Record<string, number> = Object.fromEntries(
    Object.entries(options.skills).map(([name, v]) => [name, Math.round(v * 10)])
  );
  let digs = 0;
  let seam = true;
  let gift = false;
  let greeted = false;

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
      if (serial === MARCY_SERIAL) world.apply(nameReply(serial, 'Marcy'));
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
      if (serial === MARCY_SERIAL) {
        // Addressing her opens the little menu of what she has to say or give.
        world.apply(gump(MARCY_SERIAL, MARCY_GUMP, '{ button 40 60 4005 4007 1 0 1 }{ button 40 84 4005 4007 1 0 2 }'));
        return;
      }
      world.apply(targetCursor(cursors++));
    },
    replyGump(serial: number, id: number, button: number) {
      session.send(gumpReply(serial, id, button, [], []));
      world.gumps.delete(`${serial}:${id}`);
      if (serial !== MARCY_SERIAL || id !== MARCY_GUMP) return;
      if (button === 1) {
        greeted = true;
        world.apply(speech(MARCY_SERIAL, 'Marcy', MARCY_SAYS.greet));
        return;
      }
      if (button === 2) {
        if (gift) {
          world.apply(speech(MARCY_SERIAL, 'Marcy', MARCY_SAYS.spent));
          return;
        }
        gift = true;
        gold += 3;
        repack();
        world.apply(speech(MARCY_SERIAL, 'Marcy', MARCY_SAYS.gift));
      }
    },
    dig() {
      digs++;
      if (!seam) {
        world.apply(systemText('There is nothing more to dig here.'));
        return;
      }
      if (digs > SEAM) seam = false;
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
    selectContext() {},
    async purchaseItem() {
      throw new Error('purchaseItem is not part of this scenario');
    },
    async sell() {
      throw new Error('sell is not part of this scenario');
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
  world.apply(characterStatus(SELF_SERIAL, { name: 'Resident', hits: 100, maxHits: 100, weight: 60, maxWeight: 550 }));
  world.apply(itemInContainer(PICKAXE_SERIAL, PICKAXE_GRAPHIC, 1, PACK_SERIAL));
  world.apply(worldItem(70, FORGE_GRAPHIC, FORGE.x, FORGE.y, 0));
  world.apply(mobileIncoming(MARCY_SERIAL, 401, MARCY.x, MARCY.y, 0, 6));
  repack();

  const terrain = {
    bestTiles: (
      tiles: { land: number[] },
      _at: unknown,
      score: (spot: { x: number; y: number; z: number; land: number }) => number
    ) =>
      seam && tiles.land.length
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

  const places = { shrines: [], bankers: [], forges: [{ ...FORGE, id: FORGE_GRAPHIC }], vendors: [] };

  return {
    session,
    world,
    terrain,
    places,
    landAt: (_x: number, _y: number, map: number | null) => (map === 1 ? ROCK : undefined),
    stop: () => {},
    state: () => ({ ore, ingots, gold, digs, seam, greeted, gift })
  };
}

export type Social = ReturnType<typeof startSocial>;
