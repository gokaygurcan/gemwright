import { chaosOf } from './chaos';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// How full a pack is, as ServUO counts it: a backpack holds 125 items in all, nested ones included
// (Container.DefaultMaxItems), and the character carries up to its maximum weight. A gatherer
// works until one of them is nearly reached; `FULL` leaves room for a last swing and a town trip.
export const ITEM_LIMIT = 125;
export const FULL = 0.92;

export function packItems(session: PlayerSession, pack: number): Entity[] {
  const inside = (container: number): Entity[] =>
    session.world.childrenOf(container).flatMap((item) => [item, ...inside(item.serial)]);
  return inside(pack);
}

export function packFull(session: PlayerSession, pack: number, ratio = FULL) {
  const status = session.world.status;
  return packItems(session, pack).length >= ITEM_LIMIT - 8 || (!!status && status.weight >= status.maxWeight * ratio);
}

// A gatherer sometimes stops before the pack is full (chaos.ts): each call, a chance of a tenth of
// the resident's chaos once the pack is at least half full. Most loads end full.
export function leavesEarly(session: PlayerSession) {
  const status = session.world.status;
  return !!status && status.weight >= status.maxWeight * 0.5 && Math.random() < chaosOf(session) / 10;
}

// What fills a pack, for the log when a pack is full: the commonest kinds by count.
export function packSummary(session: PlayerSession, pack: number) {
  const kinds = new Map<number, number>();
  for (const item of packItems(session, pack)) kinds.set(item.graphic, (kinds.get(item.graphic) ?? 0) + 1);
  return [...kinds]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([graphic, n]) => `0x${graphic.toString(16)} x${n}`)
    .join(', ');
}
