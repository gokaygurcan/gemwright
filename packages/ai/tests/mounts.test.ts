import { expect, test } from 'bun:test';

import { canAffordMount, type MountContext } from '../src/mount-types';
import { createMountController } from '../src/mounts';
import { requestAnimalPurchase } from '../src/protocol/commerce';
import type { PlayerSession } from '../src/protocol/session';
import { playerStatus } from '../src/protocol/status';
import { WorldView } from '../src/protocol/world';

function fixture(owner = true) {
  const world = new WorldView();
  world.serial = 1;
  world.map = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  world.status = {
    intelligence: 25,
    mana: 0,
    maxMana: 0,
    hits: 74,
    maxHits: 74,
    stamina: 40,
    maxStamina: 40,
    gold: 1000,
    strength: 50,
    dexterity: 50,
    armor: 0,
    weight: 10,
    maxWeight: 200,
    followers: 1,
    maxFollowers: 5
  };
  const horse = { serial: 2, kind: 'mobile' as const, graphic: 0xcc, position: { x: 101, y: 100, z: 0, direction: 0 } };
  const equipment = { serial: 3, kind: 'item' as const, graphic: 0x3ea2, parent: 1, layer: 25 };
  world.entities.set(1, { serial: 1, kind: 'mobile', graphic: 0x190, position: world.position });
  let buys = 0,
    uses = 0,
    walks = 0,
    followTarget: number | undefined;
  const session = {
    world,
    phase: 'ready',
    context: async () => [
      ...(owner ? [{ index: 0, cliloc: 3006107, flags: 0 }] : []),
      { index: 1, cliloc: 3006108, flags: 0 }
    ],
    purchaseAnimal: async () => {
      buys++;
    },
    setWarMode: () => {},
    use: (serial: number) => {
      uses++;
      if (serial === 1) {
        world.entities.delete(3);
        world.entities.set(2, horse);
      } else {
        world.entities.delete(2);
        world.entities.set(3, equipment);
      }
    },
    waitFor: async (predicate: () => boolean) => {
      if (!predicate()) throw new Error('Unconfirmed server action');
    },
    selectContext: () => {
      world.target = { id: 10, ground: false, flags: 0 };
    },
    target: (target: { serial: number }) => {
      followTarget = target.serial;
      world.target = null;
    }
  } as unknown as PlayerSession;
  const ctx: MountContext = {
    session,
    checkpoint: { goal: null, memories: [], relationships: {} },
    serial: 1,
    terrain: {
      stand: (x: number, y: number, z: number) => ({ x, y, z }),
      cell: () => ({ statics: [] })
    } as unknown as MountContext['terrain'],
    position: () => {
      if (!world.position) throw new Error('No position');
      return world.position;
    },
    status: () => {
      if (!world.status) throw new Error('No status');
      return world.status;
    },
    check: () => {},
    navigate: async () => {
      walks++;
    },
    phase: () => {},
    log: () => {},
    persist: () => {},
    backpack: () => 4
  };
  return { world, ctx, horse, equipment, counts: () => ({ buys, uses, walks, followTarget }) };
}

test('mount spending preserves the reserve and animal requests require a free follower slot and current vendor stock', () => {
  expect(canAffordMount(550, 799, 250)).toBe(false);
  expect(canAffordMount(550, 800, 250)).toBe(true);
  expect(canAffordMount(751, 2000, 250)).toBe(false);
  const { world, ctx } = fixture();
  world.entities.set(5, { serial: 5, kind: 'item', graphic: 0x2af8, parent: 6 });
  world.entities.set(7, { serial: 7, kind: 'item', graphic: 0xcc, parent: 5, amount: 10 });
  world.buyOffers.set(5, [{ serial: 7, price: 550, description: 'a horse' }]);
  const packets: Buffer[] = [];
  requestAnimalPurchase(ctx.session, (packet) => packets.push(packet), 6, 7, 550);
  expect(packets).toHaveLength(1);
  expect(packets[0]?.[0]).toBe(0x3b);
  if (!world.status) throw new Error('No status');
  world.status.followers = 5;
  expect(() => requestAnimalPurchase(ctx.session, () => {}, 6, 7, 550)).toThrow('follower');
  world.status.followers = 0;
  expect(() => requestAnimalPurchase(ctx.session, () => {}, 8, 7, 550)).toThrow();
});

test('a pending purchase without a visible owned horse never issues another purchase or savings withdrawal', async () => {
  const { ctx, counts } = fixture();
  ctx.checkpoint.mount = {
    schemaVersion: 1,
    state: 'purchase-pending',
    pending: { vendor: 8, stock: 7, price: 550, at: Date.now(), map: 1, x: 100, y: 100, z: 0, before: [] }
  };
  await createMountController(ctx, 'Britain').acquire();
  expect(counts()).toEqual({ buys: 0, uses: 0, walks: 0, followTarget: undefined });
  expect(ctx.checkpoint.mount.pending).toBeDefined();
});

test('reconnect recognizes actual mount equipment, then gathering dismounts, follows and remounts the owned horse', async () => {
  const { ctx, world, equipment, counts } = fixture();
  world.entities.set(equipment.serial, equipment);
  const controller = createMountController(ctx, 'Britain');
  await controller.acquire();
  expect(ctx.checkpoint.mount?.state).toBe('riding');
  expect(counts().buys).toBe(0);
  await controller.dismountForGathering();
  expect(world.entities.has(equipment.serial)).toBe(false);
  expect(counts().followTarget).toBe(1);
  expect(ctx.checkpoint.mount?.horse).toBe(2);
  expect(await controller.ride()).toBe(true);
  expect(world.entities.has(equipment.serial)).toBe(true);
});

test('friend commands alone cannot establish ownership', async () => {
  const { ctx, world, horse, counts } = fixture(false);
  world.entities.set(horse.serial, horse);
  expect(await createMountController(ctx, 'Britain').ride()).toBe(false);
  expect(ctx.checkpoint.mount?.horse).toBeUndefined();
  expect(counts().uses).toBe(0);
});

test('modern status extracts follower capacity only when the bytes are present', () => {
  const packet = Buffer.alloc(73);
  packet[42] = 5;
  packet[71] = 2;
  packet[72] = 5;
  expect(playerStatus(packet).followers).toBe(2);
  expect(playerStatus(packet).maxFollowers).toBe(5);
  expect(playerStatus(packet.subarray(0, 69)).followers).toBeUndefined();
});

test('an unavailable horse context does not stop gathering after a confirmed dismount', async () => {
  const { ctx, world, equipment } = fixture();
  world.entities.set(equipment.serial, equipment);
  ctx.session.context = async () => {
    throw new Error('Timed out waiting for context menu');
  };
  const controller = createMountController(ctx, 'Britain');
  await controller.dismountForGathering();
  expect(world.entities.has(equipment.serial)).toBe(false);
  expect(ctx.checkpoint.mount?.note).toContain('not confirmed');
});
