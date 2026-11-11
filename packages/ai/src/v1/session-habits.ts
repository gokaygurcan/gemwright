import { canPause } from './action-purpose';
import { threatsNear } from './danger';
import type { LifeContext } from './life';
import { cityLandmarks, serviceLocations } from './locations';
import { distance } from './navigation';
import { hasSessionHabits } from './resident-context';
import { personalMemory } from './resident-memory';
import type { Checkpoint } from './store';

export class SessionBreak extends Error {
  constructor() {
    super('Taking a break after reaching a safe place');
  }
}
function variation(seed: number, salt: number) {
  return ((Math.imul(seed ^ salt, 2654435761) >>> 0) % 1000) / 1000;
}
export function sessionHabits(checkpoint: Checkpoint, serial: number, now = Date.now()) {
  const memory = personalMemory(checkpoint, now);
  memory.habits ??= {
    sessionUntil: now + (45 + variation(serial, 11) * 105) * 60_000,
    offlineUntil: 0,
    style: (['plain', 'friendly', 'reserved'] as const)[Math.floor(variation(serial, 19) * 3)] ?? 'plain'
  };
  if (memory.habits.offlineUntil > 0 && memory.habits.offlineUntil <= now) {
    memory.habits.offlineUntil = 0;
    memory.habits.sessionUntil = now + (45 + variation(serial, Math.floor(now / 86400_000)) * 105) * 60_000;
  }
  return memory.habits;
}

export async function sessionBreakTurn(ctx: LifeContext, now = Date.now()) {
  const { session, checkpoint } = ctx;
  if (!hasSessionHabits(session) || session.world.serial === null) return;
  const habits = sessionHabits(checkpoint, session.world.serial, now);
  if (
    now < habits.sessionUntil ||
    !canPause(session) ||
    session.world.status?.hits === 0 ||
    (session.world.trade && !session.world.trade.closed) ||
    (checkpoint.personal?.commitment && ['active', 'paused'].includes(checkpoint.personal.commitment.state)) ||
    checkpoint.personal?.orders.some((order) => ['accepted', 'ready'].includes(order.state)) ||
    (checkpoint.hunting?.recovery && checkpoint.hunting.recovery.stage !== 'ready') ||
    threatsNear(session, ctx.position(), 12).length
  )
    return;
  const stops = [...cityLandmarks(ctx.city, /\b(inn|tavern)\b/i), ...serviceLocations(ctx.city, 'banker')].sort(
    (a, b) => distance(ctx.position(), a) - distance(ctx.position(), b)
  );
  const stop = stops[0];
  if (!stop || distance(ctx.position(), stop) > 100) return;
  await ctx.navigate(stop, 3);
  if (
    !canPause(session) ||
    session.world.status?.hits === 0 ||
    distance(ctx.position(), stop) > 3 ||
    (session.world.trade && !session.world.trade.closed) ||
    checkpoint.personal?.orders.some((order) => ['accepted', 'ready'].includes(order.state)) ||
    (checkpoint.personal?.commitment && ['active', 'paused'].includes(checkpoint.personal.commitment.state)) ||
    threatsNear(session, ctx.position(), 12).length
  )
    return;
  habits.offlineUntil = Date.now() + (10 + variation(session.world.serial, Math.floor(now / 60_000)) * 35) * 60_000;
  ctx.phase('session-break', 'Reached a safe stopping place; taking a break');
  ctx.persist();
  throw new SessionBreak();
}
