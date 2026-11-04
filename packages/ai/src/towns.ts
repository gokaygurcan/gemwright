import type { PlayerSession } from '@gemwright/network/session';

import { absence } from './absence';
import { moongates, nearestGate } from './gates';
import { HAVEN_CITY, havenResident } from './haven';
import { allServiceLocations, forgeSites, type ServiceType, serviceLocations, townAt } from './locations';
import { distance } from './navigation';
import { outgrewYoung } from './progression';
import { cityAllowed } from './world';

// No resident has a home town. It works from whichever town supports its trade — a bank and the
// trade's own vendor, a forge for a miner — staying while that holds and moving to the nearest
// town that does when it stops (shops found empty count against a town). The young of New Haven
// prefer their island while it serves them, but nothing keeps them there.
export class TownChanged extends Error {
  constructor(readonly town: string) {
    super(`Moving my work to ${town}`);
  }
}

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
  const young = havenResident(session) && !outgrewYoung(session);
  const haven = HAVEN_CITY.toLowerCase();
  if (young && cityAllowed(haven) && supports(session, trade, haven)) return haven;
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

// Every turn (goal-turn.ts): a town that no longer supports the work ends the run, and the next run
// starts from the nearest one that does.
export function townTurn(session: PlayerSession, trade: string, town: string) {
  if (supports(session, trade, town)) return;
  const next = townFor(session, trade);
  if (next !== town.toLowerCase()) throw new TownChanged(next);
}
