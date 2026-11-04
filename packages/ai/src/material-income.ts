import { board, logPile } from '@gemwright/common/game/items';

import { TOOLS } from './bank-gold';
import { unsafeCheck } from './danger';
import { packFull } from './inventory';
import { chopTree } from './lumber-chop';
import { treeStatics } from './lumber-trees';
import { distance } from './navigation';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import type { ProfessionContext } from './profession';
import { onItem, useOn } from './target-action';
import { hatchets } from './vendor-catalog';
import { buyTool, sellTo } from './vendor-trade';

// A bowyer whose finished goods have no buyer can still earn by supplying raw wood.
export async function earnBoards(ctx: ProfessionContext): Promise<boolean> {
  const { session, checkpoint } = ctx;
  const key = 'income:boards';
  if (objectiveBlocked(checkpoint, key, suppliesCondition(session, checkpoint))) return false;
  const sell = () => sellTo(ctx, 'carpenter', (item) => [board, logPile].includes(item.graphic) && !item.hue);
  if ((await sell()) > 0) {
    completeObjective(checkpoint, key);
    return true;
  }
  const tool = () =>
    [...session.world.childrenOf(ctx.serial), ...ctx.carried()].find((item) => hatchets.has(item.graphic));
  if (!tool()) await buyTool({ ...ctx, limits: TOOLS }, 'blacksmith', [...hatchets]);
  const unsafe = unsafeCheck(session);
  const trees = ctx.terrain
    .findStatics(treeStatics, ctx.position(), 60)
    .filter((tree) => !unsafe(tree))
    .sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b));
  for (const tree of trees.slice(0, 3)) {
    ctx.check();
    if (!tool()) break;
    const treeKey = `wood:${tree.x},${tree.y}`;
    if (objectiveBlocked(checkpoint, treeKey, 'depleted')) continue;
    ctx.phase('gathering-income', 'Gathering wood while finished goods have no buyer');
    try {
      await ctx.navigate(tree, 1);
      await chopTree(
        {
          session,
          check: ctx.check,
          say: ctx.log,
          tool,
          cutBoards: async () => {},
          full: () => packFull(session, ctx.backpack()),
          logs: () => ctx.count(logPile),
          noted: ctx.persist,
          describe: () => 'wood for sale'
        },
        tree
      );
      failObjective(checkpoint, treeKey, 'depleted', 'Worked this tree; allowing its resources to recover');
      if (ctx.count(logPile)) {
        const log = ctx.carried().find((item) => item.graphic === logPile && !item.hue);
        const axe = tool();
        if (log && axe) {
          await useOn(session, () => session.use(axe.serial), onItem(log), { label: 'cutting wood cursor' });
          await session
            .waitFor(() => !session.world.entities.has(log.serial) || ctx.count(board) > 0, 'boards observed', 4000)
            .catch(() => {});
        }
        if ((await sell()) > 0) {
          completeObjective(checkpoint, key);
          return true;
        }
      }
    } catch (error) {
      ctx.check();
      failObjective(checkpoint, treeKey, 'depleted', String(error));
    }
  }
  failObjective(checkpoint, key, suppliesCondition(session, checkpoint), 'No reachable wood or buyer right now');
  ctx.persist();
  return false;
}
