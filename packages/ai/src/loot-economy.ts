import { crossbowBolt, gold } from '@gemwright/common/game/items';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { valuable } from './fighter-context';
import { magicProperty } from './item-quality';
import { personalMemory } from './resident-memory';
import type { Checkpoint } from './store';

export function lootPriority(item: Entity): number {
  if (item.graphic === gold) return 10000;
  if (item.graphic >= 0xf10 && item.graphic <= 0xf30) return 1000;
  if ([0xf3f, crossbowBolt, 0xe21, 0xf0c, 0xf07].includes(item.graphic)) return 700;
  if (item.properties?.some((p) => magicProperty(p.cliloc))) return 500;
  if (valuable(item.graphic)) return 200;
  return 0;
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
