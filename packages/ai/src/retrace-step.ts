import type { PlayerSession } from '@gemwright/network/session';

import type { createDoorOpener } from './doors';
import { directionTo } from './terrain';

export async function retraceStep(
  session: PlayerSession,
  check: () => void,
  open: ReturnType<typeof createDoorOpener>,
  attempted: Set<string>,
  log: (message: string) => void
): Promise<boolean> {
  check();
  const position = session.world.position;
  const initial = position && { ...position };
  if (!initial || !session.movementTrail) return false;
  const previous = session.movementTrail.reverse(initial, session.world.map);
  if (!previous) return false;
  const key = `${initial.x},${initial.y},${initial.z}->${previous.x},${previous.y},${previous.z}`;
  if (attempted.has(key)) return false;
  attempted.add(key);
  // An ACK has no height: get the actual server position before trusting an inferred trail endpoint.
  if (!(await session.resyncPosition())) return false;
  check();
  const from = session.world.position;
  if (!from || from.x !== initial.x || from.y !== initial.y || from.z !== initial.z) return false;
  if ((await open(from, previous)).blocked) return false;
  const direction = directionTo(from, previous);
  if (direction < 0) return false;
  if (from.direction !== direction && !(await session.walk(direction))) return false;
  check();
  if (!(await session.walk(direction, previous.z))) {
    session.movementTrail.clear();
    return false;
  }
  if (!(await session.resyncPosition())) return false;
  check();
  const at = session.world.position;
  const arrived = !!at && at.x === previous.x && at.y === previous.y && at.z === previous.z;
  if (arrived) log(`Retraced an acknowledged step to server-confirmed ${at.x},${at.y},${at.z}; replanning the exit`);
  else session.movementTrail.clear();
  return arrived;
}
