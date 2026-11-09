import type { PlayerSession } from '@gemwright/network/session';

import { absence } from './absence';
import { moongates, nearestGate } from './gates';
import { HAVEN_CITY } from './haven';
import { allServiceLocations, forgeSites, type ServiceType, serviceLocations, townAt } from './locations';
import { distance } from './navigation';
import { cityAllowed } from './world';

// A resident works from the town it is in when that town supports its trade — a bank and the
// trade's own vendor, a forge for a miner — else from the nearest one that does (shops found empty
// count against a town), read afresh wherever it stands. Young residents favour Haven Island in
// their choices of ground and outing (haven.ts), never as a town to work from.

const NEEDS: Record<string, ServiceType[]> = {
  fisher: ['banker', 'fisherman'],
  tailor: ['banker', 'tailor'],
  lumberjack: ['banker', 'carpenter'],
  alchemist: ['banker', 'alchemist'],
  bowyer: ['banker', 'bowyer'],
  tamer: ['banker', 'animal-trainer'],
  fighter: ['banker', 'healer'],
  miner: ['banker']
};
const towns = () =>
  [...new Set(allServiceLocations('banker').map((bank) => bank.city.toLowerCase()))].filter((town) =>
    cityAllowed(town)
  );
// A place counts as its nearest town's (within 250 tiles, townAt); the wilds beyond belong to none.
export const placeAllowed = (point: { x: number; y: number }) => cityAllowed(townAt(point, ''));

// The catalogue lists the shard's shops; a spot this resident found empty lately is not one (absence.ts).
function serves(session: PlayerSession, town: string, service: ServiceType) {
  return serviceLocations(town, service).some(
    (shop) => !absence(session.world.serial ?? -1).seen('vendor', shop, service)
  );
}

export function supports(session: PlayerSession, trade: string, town: string) {
  const forge = trade !== 'miner' || forgeSites.some((site) => site.city.toLowerCase() === town.toLowerCase());
  return forge && (NEEDS[trade] ?? ['banker', 'provisioner']).every((need) => serves(session, town, need));
}

export function townFor(session: PlayerSession, trade: string) {
  const here = session.world.position ?? { x: 0, y: 0 };
  const current = townAt(here, '').toLowerCase();
  const haven = HAVEN_CITY.toLowerCase();
  if (current && cityAllowed(current) && supports(session, trade, current)) return current;
  // Travel as residents travel: on foot, or to the nearest moongate and from the gate by the town.
  const cost = (to: { x: number; y: number }) =>
    Math.min(
      distance(here, to),
      distance(here, moongates[nearestGate(here)]) + distance(moongates[nearestGate(to)], to)
    );
  const near = (town: string) => Math.min(...serviceLocations(town, 'banker').map(cost));
  return (
    towns()
      .filter((town) => supports(session, trade, town))
      .sort((a, b) => near(a) - near(b))[0] ??
    [current, haven, ...towns()].find((town) => town && cityAllowed(town)) ??
    haven
  );
}
