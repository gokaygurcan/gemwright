import { canPause } from './action-purpose';
import { threatsNear } from './danger';
import type { LifeContext } from './life';
import { distance } from './navigation';
import { residentCombat } from './resident-context';
import { personalMemory } from './resident-memory';

export function companionInitiative(ctx: LifeContext, now = Date.now()): boolean {
  const memory = personalMemory(ctx.checkpoint, now),
    current = memory.commitment;
  if (
    !residentCombat(ctx.session) ||
    !canPause(ctx.session) ||
    (ctx.session.world.trade && !ctx.session.world.trade.closed) ||
    (current && (['active', 'paused'].includes(current.state) || current.lootDue > 0)) ||
    memory.orders.some((o) => ['accepted', 'ready'].includes(o.state)) ||
    now - (memory.lastCompanionOfferAt ?? 0) < 10 * 60_000 ||
    threatsNear(ctx.session, ctx.position(), 12).length
  )
    return false;
  const partner = Object.entries(memory.partners).find(([serial, person]) => {
    const entity = ctx.session.world.entities.get(Number(serial));
    return (
      person.trust >= 0.25 &&
      entity?.position &&
      distance(ctx.position(), entity.position) <= 4 &&
      memory.episodes.filter(
        (e) => e.partner === Number(serial) && ['outing', 'plan'].includes(e.kind) && e.result === 'completed'
      ).length >= 2
    );
  });
  if (!partner) return false;
  memory.lastCompanionOfferAt = now;
  ctx.session.say(
    `${partner[1].name.split(' ')[0]}, good to see you. If you want another short round, ask me to hunt together.`
  );
  ctx.persist();
  return true;
}
