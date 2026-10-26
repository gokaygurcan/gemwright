import { checkedDelay } from './action-purpose';
import { tally } from './activity';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// Lumberjacking.cs replies: AOS resource messages 1072540-1072546 or the classic 500498 on
// success, 500495 on a failed chop, 500493 depleted tree, 500446 too far, 500497 pack full,
// 500499 broken axe.
const CHOPPED = [500498, 1072540, 1072541, 1072542, 1072543, 1072544, 1072545, 1072546];
const FAILED = 500495;
const DEPLETED = [500493, 500446, 500494];
const PACK_FULL = 500497;
const BROKE = 500499;

interface ChopContext {
  session: PlayerSession;
  check: () => void;
  say: (message: string) => void;
  tool: () => Entity | undefined;
  cutBoards: () => Promise<void>;
  // The pack is full (inventory.ts); `logs` counts carried logs, which cutting would lighten.
  full: () => boolean;
  logs: () => number;
  noted: () => void;
  describe: () => string;
}

// Chops one tree until it has no wood left, the pack is full or the axe breaks. `answered` is
// false when the tree never replied with wood or a miss (not a tree the server lets us work).
export async function chopTree(ctx: ChopContext, tree: { x: number; y: number; z: number; id: number }) {
  const { session } = ctx;
  const result = { gathered: 0, answered: false, depleted: false, full: false };
  for (let swing = 0; swing < 40; swing++) {
    ctx.check();
    const axe = ctx.tool();
    if (!axe) break;
    const seen = new Set(session.world.journal);
    session.use(axe.serial);
    await session.waitFor(() => session.world.target !== null, 'hatchet cursor', 4000);
    session.target({ serial: 0, x: tree.x, y: tree.y, z: tree.z, graphic: tree.id });
    await checkedDelay(2500, ctx.check);
    const replies = session.world.journal.filter((entry) => !seen.has(entry) && entry.cliloc !== undefined);
    const has = (clilocs: number[]) => replies.some((entry) => clilocs.includes(entry.cliloc ?? 0));
    ctx.noted();
    if (has(CHOPPED)) {
      result.gathered++;
      tally(session, 'chopped');
    }
    if (has(CHOPPED) || has([FAILED])) result.answered = true;
    if (has(DEPLETED)) {
      result.depleted = true;
      break;
    }
    if (has([PACK_FULL])) {
      await ctx.cutBoards();
      if (ctx.full()) {
        ctx.say(`Pack full (${ctx.describe()})`);
        result.full = true;
      }
      break;
    }
    if (has([BROKE])) break;
    if (!replies.length)
      throw new Error('Chopping produced no interpretable feedback; stopping instead of repeating blindly');
    if (!has(CHOPPED) && !has([FAILED])) {
      ctx.say(`Unexpected chopping reply: ${replies.map((entry) => entry.cliloc).join(', ')}`);
      break;
    }
    if (ctx.full()) {
      if (ctx.logs()) await ctx.cutBoards();
      if (ctx.full()) {
        result.full = true;
        break;
      }
    }
  }
  return result;
}
