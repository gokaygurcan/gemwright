import { gold } from '@gemwright/common/items';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import { lifeEvent } from './life-events';
import type { Checkpoint } from './store';

const tallies = new WeakMap<PlayerSession, Record<string, number>>();
export const workCounts = (session: PlayerSession) => ({ ...tallies.get(session) });
export function tally(session: PlayerSession, name: string, amount = 1) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const counts = tallies.get(session) ?? {};
  counts[name] = (counts[name] ?? 0) + amount;
  tallies.set(session, counts);
  lifeEvent(session, 'work_result', 'observed', { counter: name, amount, total: counts[name] });
}

export interface WorkEvidence {
  skills: Record<string, number>;
  funds: number;
  bankKnown: boolean;
  gold: number;
  products: number;
  orders: number;
  goods: number;
  health: number;
}
const banks = new WeakMap<PlayerSession, number>();
export const rememberBalance = (session: PlayerSession, amount: number) => banks.set(session, amount);

export function workEvidence(
  session: PlayerSession,
  checkpoint?: Checkpoint,
  skills?: readonly number[]
): WorkEvidence {
  const counts = workCounts(session);
  let coins = 0;
  let goods = 0;
  const seen = new Set<number>();
  const visit = (parent: number) => {
    if (seen.has(parent)) return;
    seen.add(parent);
    for (const item of session.world.childrenOf(parent)) {
      if (item.layer === Layer.Bank) continue;
      if (item.graphic === gold) coins += item.amount ?? 1;
      else goods += item.amount ?? 1;
      visit(item.serial);
    }
  };
  visit(session.world.serial ?? -1);
  const bank = checkpoint?.funds?.bank ?? banks.get(session);
  return {
    skills: Object.fromEntries(
      [...session.world.skills].filter(([id]) => !skills || skills.includes(id)).map(([id, s]) => [id, s.base])
    ),
    funds: coins + (bank ?? 0),
    bankKnown: bank !== undefined,
    gold: coins,
    products: ['mined', 'chopped', 'fished', 'crafted'].reduce((sum, name) => sum + (counts[name] ?? 0), 0),
    orders: counts.bulkOrdersTurnedIn ?? 0,
    goods,
    health: session.world.status?.hits ?? 0
  };
}

export function skillGrowth(before: WorkEvidence, after: WorkEvidence) {
  return Object.entries(after.skills).reduce((sum, [id, value]) => sum + value - (before.skills[id] ?? value), 0);
}
export function earnedGold(before: WorkEvidence, after: WorkEvidence) {
  return before.bankKnown === after.bankKnown ? after.funds - before.funds : 0;
}

// High-water marks prevent damage/heal cycles, spending/withdrawals and skill loss/regain from
// repeatedly resetting the guard. Possession counts and movement are never proof of a gain.
export function positiveProgress(high: WorkEvidence, current: WorkEvidence): boolean {
  const gained =
    skillGrowth(high, current) > 0 ||
    earnedGold(high, current) > 0 ||
    current.products > high.products ||
    current.orders > high.orders;
  if (high.bankKnown !== current.bankKnown) {
    high.bankKnown = current.bankKnown;
    high.funds = current.funds;
  } else high.funds = Math.max(high.funds, current.funds);
  for (const [id, value] of Object.entries(current.skills)) high.skills[id] = Math.max(high.skills[id] ?? value, value);
  high.products = Math.max(high.products, current.products);
  high.orders = Math.max(high.orders, current.orders);
  return gained;
}
