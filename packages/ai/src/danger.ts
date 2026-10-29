import type { PlayerSession } from '@gemwright/network/session';

import { callOutReds, hearCalls } from './danger-calls';
import { lasting } from './lasting';
import { distance } from './navigation';
import { perceptionFor } from './perception-session';

const REMEMBER_MS = 20 * 60_000;
const cell = (point: { x: number; y: number }) => `${point.x >> 4},${point.y >> 4}`;

export function threatsNear(session: PlayerSession, point: { x: number; y: number }, radius: number) {
  const seen = lasting('danger', session.world.serial ?? 0);
  const model = perceptionFor(session);
  const perceived = model.visibleEntities('mobile');
  const threats = perceived
    .filter(
      (e) =>
        e.serial !== session.world.serial &&
        e.facts.value.kind === 'mobile' &&
        e.risk.value !== 'unknown' &&
        !session.world.deaths.has(e.serial)
    )
    .map((e) => e.facts.value);
  for (const threat of threats) if (threat.position) seen.set(cell(threat.position), Date.now() + REMEMBER_MS);
  // Red players are called out, and others' calls heard (danger-calls.ts).
  callOutReds(session, threats, (mobile) => model.entity(mobile.serial)?.reference.value.humanLike ?? false);
  hearCalls(session, seen, cell);
  return threats.filter((threat) => threat.position && distance(point, threat.position) <= radius);
}

// A check for many candidate spots: unsafe with a threat within ten tiles, or in an area where
// one was lately seen. Threats are read once, when the check is made.
export function unsafeCheck(session: PlayerSession) {
  const threats = threatsNear(session, session.world.position ?? { x: 0, y: 0 }, Number.POSITIVE_INFINITY);
  const seen = lasting('danger', session.world.serial ?? 0);
  return (point: { x: number; y: number }) =>
    seen.active(cell(point)) || threats.some((threat) => threat.position && distance(point, threat.position) <= 10);
}

export function rememberAttack(session: PlayerSession, point: { x: number; y: number; z?: number }) {
  const serial = session.world.serial ?? -1;
  lasting('danger', serial).set(cell(point), Date.now() + 30 * 60_000);
  lasting('attacked-sites', serial).set(
    `${session.world.map}:${point.x},${point.y},${point.z ?? session.world.position?.z ?? 0}`,
    Date.now() + 30 * 60_000
  );
}

export function rememberedDangerTiles(session: PlayerSession, from: { x: number; y: number; z: number }) {
  const blocked = new Set<string>();
  const prefix = `${session.world.serial ?? -1}|${session.world.map}:`;
  for (const [key, until] of lasting('attacked-sites').entries()) {
    if (!key.startsWith(prefix) || until <= Date.now()) continue;
    const [x = 0, y = 0, z = 0] = key.slice(prefix.length).split(',').map(Number);
    if (Math.abs(from.z - z) > 16) continue;
    const now = Math.hypot(from.x - x, from.y - y);
    for (let dx = -8; dx <= 8; dx++)
      for (let dy = -8; dy <= 8; dy++)
        if (Math.hypot(dx, dy) <= 8 && Math.hypot(dx, dy) < now) blocked.add(`${x + dx},${y + dy}`);
  }
  return blocked;
}
