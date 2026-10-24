import type { DungeonContext } from './dungeon-context';
import { adoptDungeon, crawlDungeon, startSoloRun } from './dungeon-crawl';
import { followDungeon } from './dungeon-follow';
import { leaderParty, musterOrJoin } from './dungeon-party';

// One turn spent on dungeons, for any profession: resume or start a run (alone at 100.0
// primaries, otherwise by joining or mustering a party) and play it out. `start` false only
// resumes a run already under way. False when this turn goes to the character's usual work.
export async function dungeonTurn(ctx: DungeonContext, start = true): Promise<boolean> {
  adoptDungeon(ctx);
  if (!ctx.checkpoint.dungeon && (!start || (!startSoloRun(ctx) && !(await musterOrJoin(ctx))))) return false;
  const run = ctx.checkpoint.dungeon;
  if (!run) return false;
  if (run.party?.role === 'member' && (await followDungeon(ctx)) !== 'lead') return true;
  const party = ctx.checkpoint.dungeon?.party;
  if (ctx.checkpoint.dungeon) await crawlDungeon(ctx, party ? leaderParty(ctx, party.id) : undefined);
  return true;
}
