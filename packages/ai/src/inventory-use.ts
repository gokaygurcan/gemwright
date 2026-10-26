import { gold, isDeathRobe } from '@gemwright/common/items';

import { canPause } from './action-purpose';
import { weaponsFor } from './fighter-context';
import { usefulRepairContract } from './guild-repairs';
import { packItems } from './inventory';
import { info } from './log';
import { residentNeeds } from './needs';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { residentContext, residentTerrain } from './resident-context';
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

export async function betterEquipment(session: PlayerSession, item: Entity): Promise<boolean> {
  const ctx = residentContext(session),
    terrain = residentTerrain(session),
    status = session.world.status;
  if (!ctx || !terrain || !status) return false;
  const tile = terrain.tile(item.graphic, true);
  const layer = tile.layer;
  if (!(tile.flags & 0x400000) || reserved.has(layer) || isDeathRobe(item)) return false;
  const weapon = weaponsFor(ctx.template).has(item.graphic);
  if ((layer === 1 || layer === 2) && !weapon && !/shield|buckler/i.test(tile.name)) return false;
  if (
    ctx.template.archetype?.primarySkills.includes('Magery') &&
    (layer === 1 || layer === 2 || /plate|chain|ringmail|bone|metal/i.test(tile.name))
  )
    return false;
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
    miner: [0x1bf2, 0x19b7, 0x19b8, 0x19b9, 0x19ba],
    lumberjack: [0x1bd7, 0x1bdd],
    tailor: [0x1766, 0x1767, 0x0f95, 0x0df8, 0x0e1d, 0x0e1e, 0x0e1f, 0x0f9e, 0x0f9f],
    bowyer: [0x1bd7, 0x1bdd, 0x1bd1, 0x1bd4],
    alchemist: [0x0f0e, 0x0f7a, 0x0f7b, 0x0f84, 0x0f85, 0x0f86, 0x0f88, 0x0f8c, 0x0f8d]
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
  busy.add(session);
  try {
    const blocked = refused.get(session) ?? new Map<number, number>();
    refused.set(session, blocked);
    for (const [id, until] of blocked) if (until <= Date.now()) blocked.delete(id);
    for (const item of packItems(session, pack.serial).slice(0, 100)) {
      if (!canPause(session) || blocked.has(item.serial) || !(await betterEquipment(session, item))) continue;
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
        if (
          session.world.entities.get(item.serial)?.parent !== serial ||
          session.world.entities.get(item.serial)?.layer !== layer
        )
          throw new Error('Equipment change unconfirmed');
        info(
          `[equip:${session.world.entities.get(serial)?.name ?? serial}] Put on ${terrain.tile(item.graphic, true).name || 'something'}`
        );
        if (ctx.checkpoint.hunting)
          ctx.checkpoint.hunting.loot = ctx.checkpoint.hunting.loot.filter((id) => id !== item.serial);
        ctx.persist?.();
        return true;
      } catch (error) {
        if (session.phase !== 'ready') throw error;
        blocked.set(item.serial, Date.now() + 10 * 60_000);
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
