import type { PlayerSession } from '@gemwright/network/session';

import { recentlyHurt } from './action-purpose';
import { rememberedDangerTiles, threatsNear } from './danger';
import { beingAttacked } from './danger-response';
import { distance } from './navigation';
import type { Terrain } from './terrain';

type Point = { x: number; y: number };
type Context = {
  session: PlayerSession;
  terrain?: Terrain;
  check: () => void;
  navigate: (point: Point, range: number) => Promise<unknown>;
  phase: (phase: string, note: string) => void;
};

// One physical step per review: newly visible threats are considered before the next step.
export async function recoveryStep(ctx: Context, destination: Point | undefined): Promise<boolean> {
  const { session, terrain } = ctx;
  const position = session.world.position;
  const from = position && { ...position };
  const map = session.world.map;
  if (!terrain || !from || !destination || distance(from, destination) <= 1) return false;
  ctx.check();
  if (recentlyHurt(session) || beingAttacked(session) || (session.world.poisonLevel ?? 0) > 0) return false;
  const path = await terrain.pathAsync(
    from,
    destination,
    1,
    rememberedDangerTiles(session, from),
    undefined,
    undefined,
    true
  );
  ctx.check();
  if (!path) return false;
  const next = path.find((point) => distance(from, point) > 0);
  if (!next || distance(from, next) > 1 || threatsNear(session, next, 14).length) return false;
  const current = session.world.position;
  if (
    !current ||
    distance(current, from) > 0 ||
    current.z !== from.z ||
    session.world.map !== map ||
    recentlyHurt(session) ||
    beingAttacked(session) ||
    (session.world.poisonLevel ?? 0) > 0
  )
    return false;
  ctx.phase('recovering-travel', `Healing while advancing toward ${destination.x},${destination.y}`);
  await ctx.navigate(next, 0);
  ctx.check();
  const at = session.world.position;
  return !!at && distance(from, at) > 0;
}
