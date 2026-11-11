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

export async function travelToMiningTown(
  ctx: Pick<MountContext, 'session' | 'position' | 'navigate' | 'phase' | 'checkpoint'> & {
    city: string;
    townBank: { x: number; y: number };
    newTrip: () => NonNullable<Checkpoint['mining']>;
  }
) {
  const { session, position, navigate, phase, checkpoint, city, townBank, newTrip } = ctx;

  if (distance(position(), townBank) < 350) {
    if (distance(position(), townBank) > 150) {
      phase('town-arrival', `In the ${city} region; heading into town before choosing a mine`);
      await navigate(townBank, 5);
    }
    return;
  }
  // Farther off, through the public moongate nearest the town.
  const gate = nearestGate(townBank);
  if (distance(position(), moongates[gate]) > 2) await travelByMoongate({ session, position, navigate, phase }, gate);
  phase('town-arrival', `Arrived through the ${gate} public moongate; heading into town`);
  await navigate(townBank, 5);
  checkpoint.mining = newTrip();
  phase('town-ready', `${city} is the current mining base`);
}

// Each miner works one of the districts whose town can support it — a bank and a public forge
// (work-areas.ts) — and that town's bank is where it banks. Cove has no forge, so no miner is based there.
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
    townBank: pickLocation(city, 'banker') ?? { x: area.x, y: area.y },
    miningArea,
    anchor: offset ? { x: miningArea.x + offset.dx, y: miningArea.y + offset.dy } : miningArea,
    banks: serviceLocations(city, 'banker'),
    shops: serviceLocations(area.toolCity ?? city, 'mining-tools')
  };
}

// The way to the mining town can be long: hurt on it, it gets clear (`danger`) and goes on, instead
// of giving up the run. No way there yet ends the attempt; the work loop and its setbacks take it from there.
export async function reachMiningTown(
  ctx: Parameters<typeof travelToMiningTown>[0] & { log: (message: string) => void },
  danger: () => Promise<void>
) {
  for (let tries = 0; tries < 5; tries++) {
    try {
      await reachRegion(ctx, ctx.townBank);
      await travelToMiningTown(ctx);
      return;
    } catch (error) {
      if (error instanceof Blocked) return ctx.log(`Could not reach the mining town yet: ${error.message}`);
      if (!(error instanceof DangerInterrupt)) throw error;
      await danger();
    }
  }
}
