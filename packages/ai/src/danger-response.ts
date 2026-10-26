import { DangerInterrupt, recentlyHurt, takingUrgentAction, urgentAction } from './action-purpose';
import { shelterNearHelper } from './aid';
import { Blocked } from './blocked';
import { threatsNear } from './danger';
import type { PlayerSession } from './protocol/session';
import { residentTerrain } from './resident-context';

// Non-fighters leave before the fight starts: hurt, or a hostile creature within seven tiles.
// `sighted` is off for those whose work is near creatures (tamers, bards, thieves), and a minute
// after an escape the sighting alone does not send them off again.
const SIGHTED = 7;
const escapedAt = new WeakMap<PlayerSession, number>();
export function interruptForDanger(session: PlayerSession, sighted = true) {
  if (takingUrgentAction(session)) return;
  if (recentlyHurt(session)) throw new DangerInterrupt();
  const here = session.world.position;
  if (!sighted || !here || Date.now() - (escapedAt.get(session) ?? 0) < 60_000) return;
  if (threatsNear(session, here, SIGHTED).length) throw new DangerInterrupt();
}

// Where it was attacked, for half an hour: a way through there is avoided (dangerAhead).
const dangers = new WeakMap<PlayerSession, { x: number; y: number; at: number }[]>();
function rememberDanger(session: PlayerSession, point: { x: number; y: number }) {
  const list = (dangers.get(session) ?? []).filter((d) => Date.now() - d.at < 30 * 60_000);
  dangers.set(session, [...list, { ...point, at: Date.now() }]);
}
// True when a recent attack lies within 20 tiles of the straight way from `from` to `to`.
export function dangerAhead(session: PlayerSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  return (dangers.get(session) ?? []).some((d) => {
    if (Date.now() - d.at > 30 * 60_000) return false;
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    const t = Math.max(0, Math.min(1, ((d.x - from.x) * vx + (d.y - from.y) * vy) / Math.max(1, vx * vx + vy * vy)));
    return Math.hypot(from.x + vx * t - d.x, from.y + vy * t - d.y) < 20;
  });
}

export async function escapeDanger(
  ctx: {
    session: PlayerSession;
    check: () => void;
    phase: (phase: string, note: string) => void;
    navigate: (point: { x: number; y: number }, range: number) => Promise<unknown>;
  },
  destination: { x: number; y: number } | undefined
) {
  const { session } = ctx;
  await urgentAction(session, 'escape', async () => {
    ctx.phase('escaping', 'Leaving danger before returning to work');
    if (session.world.target) session.target(null);
    const terrain = residentTerrain(session);
    const shelter = terrain ? await shelterNearHelper(session, terrain, ctx.check) : undefined;
    // A refuge only counts when it is near and not past the attackers; otherwise it runs the
    // other way, back from them, as a player does, and the danger is remembered (dangerAhead).
    const here = session.world.position;
    const threats = here ? threatsNear(session, here, 14) : [];
    const centre = threats.length
      ? {
          x: threats.reduce((n, t) => n + (t.position?.x ?? 0), 0) / threats.length,
          y: threats.reduce((n, t) => n + (t.position?.y ?? 0), 0) / threats.length
        }
      : undefined;
    if (centre) rememberDanger(session, centre);
    const past = (p: { x: number; y: number }) =>
      !!centre && !!here && (p.x - here.x) * (centre.x - here.x) + (p.y - here.y) * (centre.y - here.y) > 0;
    const near =
      destination &&
      here &&
      Math.max(Math.abs(destination.x - here.x), Math.abs(destination.y - here.y)) < 250 &&
      !past(destination)
        ? destination
        : undefined;
    const away =
      centre && here && terrain
        ? (() => {
            const dx = here.x - centre.x;
            const dy = here.y - centre.y;
            const length = Math.max(1, Math.hypot(dx, dy));
            return terrain.stand(
              Math.round(here.x + (dx / length) * 25),
              Math.round(here.y + (dy / length) * 25),
              here.z
            );
          })()
        : undefined;
    const safe = shelter ?? near ?? away ?? destination;
    if (safe) {
      try {
        await ctx.navigate(safe, shelter ? 0 : 3);
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        ctx.phase('escape-blocked', `The way to safety is blocked: ${error.message}`);
      }
    }
    // Away until it stops hurting and the creature is out of sight range, half a minute at most.
    const until = Date.now() + 30_000;
    while (
      recentlyHurt(session) ||
      (Date.now() < until && session.world.position && threatsNear(session, session.world.position, SIGHTED).length)
    ) {
      ctx.check();
      await Bun.sleep(500);
    }
    escapedAt.set(session, Date.now());
  });
}
