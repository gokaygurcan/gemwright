import { DangerInterrupt } from './action-purpose';
import { Blocked } from './blocked';
import { moongates, nearestGate } from './gates';
import { forgeSites, pickLocation, serviceLocations } from './locations';
import { travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import type { ResidentOptions } from './resident-options';
import type { Checkpoint } from './store';
import { townFor } from './towns';
import { reachRegion, workArea } from './work-areas';

export async function travelMinerHome(
  ctx: Pick<MountContext, 'session' | 'position' | 'navigate' | 'phase' | 'checkpoint'> & {
    city: string;
    home: { x: number; y: number };
    newTrip: () => NonNullable<Checkpoint['mining']>;
  }
) {
  const { session, position, navigate, phase, checkpoint, city, home, newTrip } = ctx;

  if (distance(position(), home) < 350) {
    if (distance(position(), home) > 150) {
      phase('home-arrival', `In the ${city} region; heading into town before choosing a mine`);
      await navigate(home, 5);
    }
    return;
  }
  // From anywhere else (a miner can end up far from home), through the public moongate nearest home.
  const gate = nearestGate(home);
  if (distance(position(), moongates[gate]) > 2) await travelByMoongate({ session, position, navigate, phase }, gate);
  phase('home-arrival', `Arrived through the ${gate} public moongate; heading into town`);
  await navigate(home, 5);
  checkpoint.mining = newTrip();
  phase('home-ready', `${city} is the current mining base`);
}

// Each miner works one of the districts whose town can support it — a bank and a public forge
// (work-areas.ts) — and that town's bank is home. Cove has no forge, so no miner is based there.
export function minerDistrict(options: ResidentOptions) {
  const { session, template } = options;
  const usableMiningArea = (candidate: { city: string }) =>
    serviceLocations(candidate.city, 'banker').length > 0 &&
    forgeSites.some((forge) => forge.city.toLowerCase() === candidate.city.toLowerCase());
  const area = workArea(
    'mining',
    options.label ?? template.id,
    townFor(session, 'miner'),
    usableMiningArea,
    session.world.position ?? undefined
  );
  const city = area.city.toLowerCase();
  const miningArea = { x: area.x, y: area.y, z: 0 };
  // Each miner favours its own part of the district.
  const offset = template.behavior.temperament?.miningAnchor;
  return {
    area,
    city,
    home: pickLocation(city, 'banker') ?? { x: area.x, y: area.y },
    miningArea,
    anchor: offset ? { x: miningArea.x + offset.dx, y: miningArea.y + offset.dy } : miningArea,
    banks: serviceLocations(city, 'banker'),
    shops: serviceLocations(area.toolCity ?? city, 'mining-tools')
  };
}

// The way home can be long: hurt on it, it gets clear (`danger`) and goes on, instead of giving up
// the run. No way home yet ends the attempt; the work loop and its setbacks take it from there.
export async function reachMinerHome(
  ctx: Parameters<typeof travelMinerHome>[0] & { log: (message: string) => void },
  danger: () => Promise<void>
) {
  for (let tries = 0; tries < 5; tries++) {
    try {
      await reachRegion(ctx, ctx.home);
      await travelMinerHome(ctx);
      return;
    } catch (error) {
      if (error instanceof Blocked) return ctx.log(`Could not reach home yet: ${error.message}`);
      if (!(error instanceof DangerInterrupt)) throw error;
      await danger();
    }
  }
}
