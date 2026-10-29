import type { PlayerSession } from '@gemwright/network/session';

import { isDoor } from './doors';
import { lasting } from './lasting';
import type { Point, Terrain } from './terrain';

function doorState(session: PlayerSession, terrain: Terrain, point: Point) {
  return [...session.world.entities.values()]
    .filter(
      (e) =>
        e.kind === 'item' &&
        e.position &&
        Math.abs(e.position.x - point.x) <= 1 &&
        Math.abs(e.position.y - point.y) <= 1 &&
        Math.abs(e.position.z - point.z) < 16 &&
        isDoor(e.graphic, terrain)
    )
    .map((e) => `${e.serial}:${e.graphic}:${e.position?.x}:${e.position?.y}:${e.position?.z}`)
    .sort()
    .join(';');
}
const prefix = (session: PlayerSession) => `${session.world.serial ?? -1}|${session.world.map ?? -1}|`;

export function rememberRejectedStep(session: PlayerSession, terrain: Terrain, point: Point, refusedDoor = false) {
  const key = `${prefix(session)}${point.x},${point.y},${point.z}|${doorState(session, terrain, point)}`;
  const previous = lasting('route-refused-once');
  const repeat = previous.active(key);
  previous.set(key, Date.now() + 30_000);
  const until = Date.now() + (repeat || refusedDoor ? 3 * 60_000 : 2000);
  lasting('route-refused').set(key, until);
  return until;
}

// Retain server feedback across work targets and navigation instances, but re-test after a
// bounded expiry or when a nearby door changes. A moving mobile is never stored here.
export function rejectedSteps(session: PlayerSession, terrain: Terrain, origin: Point): Map<string, number> {
  const found = new Map<string, number>();
  const scope = prefix(session);
  for (const [key, until] of lasting('route-refused').entries()) {
    if (!key.startsWith(scope) || until <= Date.now()) continue;
    const [coordinates = '', state = ''] = key.slice(scope.length).split('|');
    const [x = 0, y = 0, z = 0] = coordinates.split(',').map(Number);
    const point = { x, y, z };
    if (Math.abs(z - origin.z) > 8 || Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y)) > 18) continue;
    if (doorState(session, terrain, point) !== state) continue;
    found.set(`${x},${y}`, until);
  }
  return found;
}
