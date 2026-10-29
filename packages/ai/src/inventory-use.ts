import { gold, isDeathRobe, magicFish, ore, reagents } from '@gemwright/common/items';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { canPause } from './action-purpose';
import { weaponsFor } from './fighter-context';
import { usefulRepairContract } from './guild-repairs';
import { packItems } from './inventory';
import { logger } from './log';
import { mountEquipment } from './mount-types';
import { residentNeeds } from './needs';
import { residentContext, residentTerrain } from './resident-context';
import type { Checkpoint } from './store';
import { professionOf } from './world';

const refused = new WeakMap<PlayerSession, Map<number, number>>();
const busy = new WeakSet<PlayerSession>();
const reserved = new Set<number>([0, Layer.Hair, Layer.FacialHair, Layer.Backpack, Layer.Mount, Layer.Bank]);
const value = (item: Entity, cliloc: number) =>
  Number.parseFloat(item.properties?.find((p) => p.cliloc === cliloc)?.arguments ?? '') || 0;

export function equipmentScore(item: Entity, weapon: boolean): number {
  if (!item.properties) return -1;
  const durability = item.properties
    .find((p) => p.cliloc === 1060639)
    ?.arguments.split('\t')
    .map(Number);
  if (durability && (durability[0] ?? 0) <= 0) return -1;
  if (weapon) {
    const [min = 0, max = 0] = (item.properties.find((p) => p.cliloc === 1061168)?.arguments ?? '')
      .split('\t')
      .map(Number);
    const speed = item.properties.find((p) => p.cliloc === 1061167)?.arguments ?? '';
    const seconds = speed.endsWith('s') ? Number.parseFloat(speed) : 40 / (Number(speed) || 13);
    return (
      ((min + max) / 2 / Math.max(1.25, seconds || 3)) *
      (1 + value(item, 1060401) / 100) *
      (1 + value(item, 1060415) / 100) *
      (1 + value(item, 1060486) / 100) *
      10
    );
  }
  return (
    value(item, 1060448) * 2 +
    [1060445, 1060446, 1060447, 1060449].reduce((n, id) => n + value(item, id), 0) +
    [1060401, 1060415, 1060408, 1060409, 1060410, 1060411, 1060412, 1060413].reduce((n, id) => n + value(item, id), 0)
  );
}

// Why a wearable piece is no use to this resident at all: not its trade's weapon, or metal armour
// a mage does not wear. Undefined when it is not wearable equipment or is a candidate to wear;
// unmatched strength needs the property list and is judged where that is read.
export function equipmentMisfit(session: PlayerSession, item: Entity): string | undefined {
  const ctx = residentContext(session);
  const terrain = residentTerrain(session);
  if (!ctx || !terrain) return;
  const tile = terrain.tile(item.graphic, true);
  const layer = tile.layer;
  if (!(tile.flags & 0x400000) || reserved.has(layer) || isDeathRobe(item)) return;
  const weapon = weaponsFor(ctx.template).has(item.graphic);
  if ((layer === 1 || layer === 2) && !weapon && !/shield|buckler/i.test(tile.name)) return "not this trade's weapon";
  if (
    ctx.template.archetype?.primarySkills.includes('Magery') &&
    (layer === 1 || layer === 2 || /plate|chain|ringmail|bone|metal/i.test(tile.name))
  )
    return 'metal armour no mage wears';
  return;
}

// An unfit piece is offered to a shop at once (selling.ts), and left behind if no shop takes it.
function markForSale(ctx: { checkpoint: Checkpoint; persist?: () => void }, serial: number, reason: string) {
  const listed = new Set(ctx.checkpoint.forSale ?? []);
  if (listed.has(serial)) return;
  listed.add(serial);
  ctx.checkpoint.forSale = [...listed].slice(-40);
  ctx.persist?.();
  logger('inventory-use').info(`[equip] item ${serial} is no use here (${reason}); marked for sale`);
}

// A magic fish (magicFish) is eaten whole for its blessing: a stat or stamina for a while, as the
// shard sets it. No vendor buys one, so a carried fish is all weight; if the shard answers that a
// like effect is already on, the fish simply waits, and the resident does not ask again for a while.
const fishUntil = new WeakMap<PlayerSession, number>();
export function eatMagicFish(session: PlayerSession): boolean {
  const serial = session.world.serial;
  if (serial === null || session.world.target || Date.now() < (fishUntil.get(session) ?? 0)) return false;
  const pack = session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
  if (!pack) return false;
  const fish = packItems(session, pack.serial).find((item) => magicFish.has(item.graphic));
  if (!fish) return false;
  session.use(fish.serial);
  // About the blessing's usual life (ServUO sets a minute, shards a few): one fish at a time.
  fishUntil.set(session, Date.now() + 3 * 60_000);
  logger('inventory-use').info(
    `[eat:${session.world.entities.get(serial)?.name ?? serial}] Ate a strange fish whole for its blessing; ${packItems(session, pack.serial).length} items in the pack`
  );
  return true;
}

export async function betterEquipment(session: PlayerSession, item: Entity): Promise<boolean> {
  const ctx = residentContext(session),
    terrain = residentTerrain(session),
    status = session.world.status;
  if (!ctx || !terrain || !status) return false;
  if (equipmentMisfit(session, item)) return false;
  const tile = terrain.tile(item.graphic, true);
  const layer = tile.layer;
  const weapon = weaponsFor(ctx.template).has(item.graphic);
  if (!item.properties) await session.inspectProperties(item.serial).catch(() => {});
  const candidate = session.world.entities.get(item.serial) ?? item;
  if (!candidate.properties || value(candidate, 1061170) > status.strength) return false;
  const worn = session.world
    .childrenOf(session.world.serial ?? -1)
    .filter((piece) =>
      weapon
        ? weaponsFor(ctx.template).has(piece.graphic) && (piece.layer === 1 || piece.layer === 2)
        : piece.layer === layer
    );
  for (const piece of worn) if (!piece.properties) await session.inspectProperties(piece.serial).catch(() => {});
  const bestHeld = Math.max(
    -1,
    ...worn.map((piece) => equipmentScore(session.world.entities.get(piece.serial) ?? piece, weapon))
  );
  return equipmentScore(candidate, weapon) > bestHeld;
}

export async function usefulGift(session: PlayerSession, item: Entity): Promise<boolean> {
  const ctx = residentContext(session);
  if (item.graphic === gold) return true;
  if (item.graphic === 0x14f0) {
    if (!item.properties) await session.inspectProperties(item.serial).catch(() => {});
    return usefulRepairContract(session, session.world.entities.get(item.serial) ?? item);
  }
  if (!ctx) return false;
  if (
    residentNeeds(session, ctx.checkpoint, ctx.template).some((need) => need.purchase?.graphics.includes(item.graphic))
  )
    return true;

  const profession = professionOf(ctx.template.id)?.[0] ?? ctx.template.archetype?.id ?? '';
  const materials: Record<string, number[]> = {
    miner: [0x1bf2, ...ore], // iron ingots, ore
    lumberjack: [0x1bd7, 0x1bdd],
    tailor: [0x1766, 0x1767, 0x0f95, 0x0df8, 0x0e1d, 0x0e1e, 0x0e1f, 0x0f9e, 0x0f9f],
    bowyer: [0x1bd7, 0x1bdd, 0x1bd1, 0x1bd4],
    alchemist: [0x0f0e, ...reagents] // bottles, reagents
  };
  if (materials[profession]?.includes(item.graphic)) return true;
  return betterEquipment(session, item);
}

// Acquired equipment is considered at the next safe boundary, independent of profession.
export async function useAcquiredItems(session: PlayerSession): Promise<boolean> {
  if (
    !canPause(session) ||
    session.world.status?.hits === 0 ||
    session.world.target ||
    busy.has(session) ||
    (session.world.trade && !session.world.trade.closed)
  )
    return false;
  const ctx = residentContext(session),
    terrain = residentTerrain(session),
    serial = session.world.serial;
  const pack = session.world.childrenOf(serial ?? -1).find((item) => item.layer === Layer.Backpack);
  if (!ctx || !terrain || serial === null || !pack) return false;
  // A magic fish in the pack is a blessing going stale: eaten first, at the next safe pause.
  if (eatMagicFish(session)) return true;
  busy.add(session);
  try {
    const blocked = refused.get(session) ?? new Map<number, number>();
    refused.set(session, blocked);
    for (const [id, until] of blocked) if (until <= Date.now()) blocked.delete(id);
    for (const item of packItems(session, pack.serial).slice(0, 100)) {
      if (!canPause(session) || blocked.has(item.serial)) continue;
      const misfit = equipmentMisfit(session, item);
      if (misfit) {
        markForSale(ctx, item.serial, misfit);
        continue;
      }
      if (!(await betterEquipment(session, item))) {
        // A strength requirement above its own (the property list was read while judging it).
        const fresh = session.world.entities.get(item.serial) ?? item;
        const need = value(fresh, 1061170);
        const strength = session.world.status?.strength ?? 0;
        if (need && need > strength) markForSale(ctx, item.serial, `needs ${need} strength`);
        continue;
      }
      if (!canPause(session)) return false;
      const layer = terrain.tile(item.graphic, true).layer;
      const handWeapon = weaponsFor(ctx.template).has(item.graphic);
      const twoHanded = item.properties?.some((p) => p.cliloc === 1061171) || (handWeapon && layer === 2);
      const old = session.world
        .childrenOf(serial)
        .filter(
          (piece) =>
            piece.layer === layer ||
            (handWeapon && twoHanded && piece.layer === 1) ||
            (layer === 1 && weaponsFor(ctx.template).has(piece.graphic) && piece.layer === 2)
        );
      try {
        for (const piece of old) await session.moveItem(piece.serial, pack.serial);
        await session.equipItem(item.serial, layer);
        // The shard picks the layer it wears the piece on; worn by us is the confirmation.
        if (session.world.entities.get(item.serial)?.parent !== serial) throw new Error('Equipment change unconfirmed');
        logger('inventory-use').info(
          `[equip:${session.world.entities.get(serial)?.name ?? serial}] Put on ${terrain.tile(item.graphic, true).name || 'something'}`
        );
        if (ctx.checkpoint.hunting)
          ctx.checkpoint.hunting.loot = ctx.checkpoint.hunting.loot.filter((id) => id !== item.serial);
        ctx.persist?.();
        return true;
      } catch (error) {
        if (session.phase !== 'ready') throw error;
        blocked.set(item.serial, Date.now() + 10 * 60_000);
        // The shard refused it: another race, gender or requirement this client cannot read. It is
        // no use here, so a shop gets it; not while mounted, when two free hands are only temporary.
        if (!mountEquipment(session.world)) markForSale(ctx, item.serial, 'the shard refused to wear it');
        for (const piece of old)
          if (piece.layer && !session.world.childrenOf(serial).some((held) => held.layer === piece.layer))
            await session.equipItem(piece.serial, piece.layer).catch(() => {});
      }
    }
    return false;
  } finally {
    busy.delete(session);
  }
}
