import { gold } from '@gemwright/common/items';

import { valuable } from './fighter-context';
import { magicProperty } from './item-quality';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { personalMemory } from './resident-memory';
import type { Checkpoint } from './store';

export function lootPriority(item: Entity): number {
  if (item.graphic === gold) return 10000;
  if (item.graphic >= 0xf10 && item.graphic <= 0xf30) return 1000;
  if ([0xf3f, 0x1bfb, 0xe21, 0xf0c, 0xf07].includes(item.graphic)) return 700;
  if (item.properties?.some((p) => magicProperty(p.cliloc))) return 500;
  if (valuable(item.graphic)) return 200;
  return 0;
}
export function pocketReserve(checkpoint: Checkpoint): number {
  const debt = checkpoint.personal?.commitment?.lootDue ?? 0;
  const order = Math.max(
    0,
    ...(checkpoint.personal?.orders ?? [])
      .filter((o) => o.side === 'buy' && ['accepted', 'ready'].includes(o.state) && o.until > Date.now())
      .map((o) => o.price)
  );
  return debt + Math.min(1000, Math.max(200, order));
}
export function observedAmount(session: PlayerSession, container: number, item: Pick<Entity, 'graphic' | 'hue'>) {
  return session.world
    .childrenOf(container)
    .filter((e) => e.graphic === item.graphic && (e.hue ?? 0) === (item.hue ?? 0))
    .reduce((sum, e) => sum + (e.amount ?? 1), 0);
}
export function recordIncome(checkpoint: Checkpoint, kind: 'lootedGold' | 'soldGold' | 'bankedGold', amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const memory = personalMemory(checkpoint);
  memory.economy ??= { lootedGold: 0, soldGold: 0, bankedGold: 0 };
  memory.economy[kind] += amount;
}
