import { anvils, smithingForges as forges } from '@gemwright/common/game/rules';

import { lasting } from './lasting';
import { serviceLocations } from './locations';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import type { Point } from './terrain';

export interface SmithingStation {
  anvil: Point;
  forge: Point;
  stand: Point;
}
type Context = Pick<
  MountContext,
  'session' | 'serial' | 'checkpoint' | 'terrain' | 'position' | 'navigate' | 'check' | 'phase' | 'log'
> & { city: string; persist?: () => void };
const used = new WeakMap<Context['session'], SmithingStation>();
const key = (station: Pick<SmithingStation, 'anvil' | 'forge'>) =>
  `${station.anvil.x},${station.anvil.y},${station.anvil.z}:${station.forge.x},${station.forge.y},${station.forge.z}`;
const near = (a: Point, b: Point, range: number) => distance(a, b) <= range && Math.abs(a.z - b.z) < 16;

function observed(ctx: Context, ids: ReadonlySet<number>): Point[] {
  return [
    ...ctx.terrain.findStatics(ids, ctx.position(), 200),
    ...[...ctx.session.world.entities.values()].flatMap((item) =>
      item.kind === 'item' && item.position && ids.has(item.graphic) ? [item.position] : []
    )
  ];
}
function remember(ctx: Context, station: SmithingStation) {
  ctx.checkpoint.landmarks ??= { forges: [] };
  const known = ctx.checkpoint.landmarks.smithies?.find(
    (s) => key(s) === key(station) && near(s.stand, station.stand, 0)
  );
  ctx.checkpoint.landmarks.smithies = [
    station,
    ...(ctx.checkpoint.landmarks.smithies ?? []).filter((s) => key(s) !== key(station))
  ].slice(0, 16);
  used.set(ctx.session, station);
  if (!known) ctx.persist?.();
}

export function rejectSmithingStation(ctx: Context) {
  const station = used.get(ctx.session);
  if (!station) return;
  lasting('smithing-station', ctx.serial).set(key(station), Date.now() + 10 * 60_000);
  used.delete(ctx.session);
  ctx.log(`Server refused the anvil/forge at ${station.anvil.x},${station.anvil.y}; trying another station`);
}

// Rediscover fixtures when returning: server-placed anvils and forges are absent from client statics.
export async function atSmithingStation(ctx: Context): Promise<boolean> {
  const tried = new Set<string>();
  const unavailable = lasting('smithing-station', ctx.serial);
  const find = async () => {
    const seenForges = observed(ctx, forges);
    const pairs = observed(ctx, anvils)
      .flatMap((anvil) => seenForges.filter((forge) => near(anvil, forge, 4)).map((forge) => ({ anvil, forge })))
      .sort((a, b) => distance(ctx.position(), a.anvil) - distance(ctx.position(), b.anvil));
    for (const pair of pairs.slice(0, 6)) {
      const id = key(pair);
      if (tried.has(id) || unavailable.active(id)) continue;
      tried.add(id);
      if (near(ctx.position(), pair.anvil, 2) && near(ctx.position(), pair.forge, 2)) {
        remember(ctx, { ...pair, stand: { ...ctx.position() } });
        return true;
      }
      const spots: Point[] = [];
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 2; dy++) {
          const spot = ctx.terrain.stand(pair.anvil.x + dx, pair.anvil.y + dy, pair.anvil.z);
          if (spot && near(spot, pair.anvil, 2) && near(spot, pair.forge, 2)) spots.push(spot);
        }
      spots.sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b));
      for (const spot of spots) {
        ctx.check();
        const path = await ctx.terrain.pathAsync(ctx.position(), spot, 0, undefined, spot.z, ctx.session.signal);
        const end = path?.at(-1);
        if (distance(ctx.position(), spot) && (!end || !near(end, spot, 0))) continue;
        ctx.phase('smithy-travel', `Taking materials to the anvil and forge at ${pair.anvil.x},${pair.anvil.y}`);
        try {
          await ctx.navigate(spot, 0);
          if (!near(ctx.position(), pair.anvil, 2) || !near(ctx.position(), pair.forge, 2)) continue;
          remember(ctx, { ...pair, stand: spot });
          return true;
        } catch {
          ctx.check();
        }
      }
    }
    return false;
  };
  if (await find()) return true;
  const remembered = [...(ctx.checkpoint.landmarks?.smithies ?? [])]
    .filter((station) => !unavailable.active(key(station)))
    .sort((a, b) => distance(ctx.position(), a.stand) - distance(ctx.position(), b.stand));
  for (const station of remembered.slice(0, 6)) {
    ctx.check();
    try {
      await ctx.navigate(station.stand, 0);
      tried.delete(key(station));
      if (await find()) return true;
      if (ctx.checkpoint.landmarks)
        ctx.checkpoint.landmarks.smithies = ctx.checkpoint.landmarks.smithies?.filter((s) => key(s) !== key(station));
    } catch {
      ctx.check();
    }
  }
  const landmarks = [...(ctx.checkpoint.landmarks?.forges ?? []), ...serviceLocations(ctx.city, 'blacksmith')]
    .filter((point) => distance(ctx.position(), point) > 18)
    .sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b));
  for (const landmark of landmarks.slice(0, 4)) {
    ctx.check();
    try {
      ctx.phase('smithy-search', `Looking for an anvil and forge near ${landmark.x},${landmark.y}`);
      await ctx.navigate(landmark, 3);
      if (await find()) return true;
    } catch {
      ctx.check();
    }
  }
  return false;
}
