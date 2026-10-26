import { canPause, urgentAction } from './action-purpose';
import { observeAid, shelterNearHelper } from './aid';
import { Blocked } from './blocked';
import { threatsNear } from './danger';
import type { FighterContext } from './fighter-context';
import { distance } from './navigation';

export async function recoverWithAid(ctx: FighterContext, heal: () => Promise<void>): Promise<boolean> {
  if (!observeAid(ctx.session).length) return false;
  try {
    return await urgentAction(ctx.session, 'escape', async () => {
      let point = await shelterNearHelper(ctx.session, ctx.terrain, ctx.check);
      if (!point) return false;
      ctx.phase('accepting-help', 'Taking a safe position near someone helping me');
      await ctx.escapeNavigate(point, 0);
      const until = Math.min(ctx.deadline, Date.now() + 12_000);
      while (Date.now() < until) {
        ctx.check();
        const threats = threatsNear(ctx.session, ctx.position(), 8);
        if (
          !threats.length &&
          ctx.status().hits >= ctx.status().maxHits * 0.75 &&
          !(ctx.session.world.poisonLevel ?? 0)
        ) {
          ctx.trip.pending = 'hunt';
          ctx.persist();
          return true;
        }
        if (threats.some((enemy) => enemy.position && distance(ctx.position(), enemy.position) < 4)) {
          point = await shelterNearHelper(ctx.session, ctx.terrain, ctx.check);
          if (!point || distance(ctx.position(), point) < 2) return false;
          await ctx.escapeNavigate(point, 0);
        }
        await heal();
        await Bun.sleep(250);
      }
      return false;
    });
  } catch (error) {
    if (ctx.dead() || error instanceof Blocked) return false;
    throw error;
  } finally {
    if (canPause(ctx.session) && !ctx.dead() && !threatsNear(ctx.session, ctx.position(), 8).length) {
      const helper = observeAid(ctx.session)[0];
      if (helper)
        ctx.session.say(
          `Thanks${helper.name ? `, ${helper.name.split(' ')[0]}` : ''}. I have a chance to recover now.`
        );
    }
  }
}
