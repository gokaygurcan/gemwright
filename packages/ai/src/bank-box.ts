import { gold } from '@gemwright/common/game/items';
import type { Entity } from '@gemwright/network/world';

import { offersBank, openBankBox, queryBankBalance } from './bank-gold';
import type { MountContext } from './mount-types';
import { distance } from './navigation';

// The bank as one player action for every resident, whatever its trade: find a banker in reach,
// open the box, move things in or out and know what actually moved. The network move is verified
// (and paced when the shard says "wait"); what it refused comes back with the shard's reason
// instead of being swallowed or assumed, so a caller never loops on a store that never happened.
type BankContext = Pick<MountContext, 'session' | 'serial' | 'position' | 'terrain' | 'navigate' | 'check'> & {
  checkpoint?: MountContext['checkpoint'];
};
export interface BankVisit {
  banker: number;
  box: number;
}
export interface Moved {
  moved: number[];
  refused: { serial: number; reason: string }[];
}

// The box of a banker within reach (speech range, ServUO Banker.HandlesOnSpeech); undefined when
// no banker here offers it.
export async function openBank(ctx: BankContext, range = 11): Promise<BankVisit | undefined> {
  const here = ctx.position();
  const bankers = [...ctx.session.world.entities.values()]
    .filter((mobile) => mobile.kind === 'mobile' && mobile.position && distance(here, mobile.position) <= range)
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here));
  for (const banker of bankers) {
    if (!(await offersBank(ctx.session, banker.serial))) continue;
    return { banker: banker.serial, box: await openBankBox(ctx, banker.serial) };
  }
}

// Moves items into a container, verified one by one (bank box, backpack, any container it can reach).
export async function transfer(
  ctx: Pick<BankContext, 'session' | 'check'>,
  items: readonly Entity[],
  to: number,
  amount?: (item: Entity) => number
) {
  const result: Moved = { moved: [], refused: [] };
  for (const item of items) {
    ctx.check();
    try {
      await ctx.session.moveItem(item.serial, to, amount?.(item));
      result.moved.push(item.serial);
    } catch (error) {
      if (ctx.session.phase !== 'ready') throw error;
      result.refused.push({ serial: item.serial, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

// Into the box; the balance is read afterwards when gold went in.
export async function deposit(ctx: BankContext, bank: BankVisit, items: readonly Entity[]): Promise<Moved> {
  const result = await transfer(ctx, items, bank.box);
  const banked = items.some((item) => item.graphic === gold && result.moved.includes(item.serial));
  if (banked && ctx.checkpoint) await queryBankBalance({ ...ctx, checkpoint: ctx.checkpoint }, bank.banker);
  return result;
}

// Out of the box into a container it carries (its backpack), optionally part of a stack.
export const withdraw = (
  ctx: BankContext,
  items: readonly Entity[],
  into: number,
  amount?: (item: Entity) => number
): Promise<Moved> => transfer(ctx, items, into, amount);
