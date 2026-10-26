import { GHOST_BODIES } from '@gemwright/common/bodies';

import { guildmates } from './guilds';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { residentContext } from './resident-context';

export function groupMember(session: PlayerSession, serial: number): boolean {
  const self = session.world.serial;
  if (self === null || self === serial) return false;
  const commitment = residentContext(session)?.checkpoint.personal?.commitment;
  return (
    session.world.partyMembers.has(serial) ||
    guildmates(self, serial) ||
    !!(commitment && ['active', 'paused'].includes(commitment.state) && commitment.partner === serial)
  );
}

export function visibleAllies(session: PlayerSession, range = 12): Entity[] {
  const here = session.world.position;
  if (!here) return [];
  return [...session.world.entities.values()].filter(
    (e) =>
      e.kind === 'mobile' &&
      e.position &&
      distance(here, e.position) <= range &&
      !GHOST_BODIES.has(e.graphic) &&
      !session.world.deaths.has(e.serial) &&
      [1, 2].includes(e.notoriety ?? 0) &&
      groupMember(session, e.serial)
  );
}

export function allyUnderPressure(session: PlayerSession, range = 10, now = Date.now()): Entity | undefined {
  const pressure = (e: Entity) =>
    [...session.world.swings].filter(
      ([, swing]) => swing.target === e.serial && now - swing.at >= 0 && now - swing.at < 6000
    ).length;
  return visibleAllies(session, range)
    .filter(
      (e) =>
        e.hits !== undefined &&
        e.hits > 0 &&
        e.maxHits &&
        e.healthAt !== undefined &&
        now - e.healthAt >= 0 &&
        now - e.healthAt < 10_000 &&
        (e.hits / e.maxHits < 0.8 || !!((e.flags ?? 0) & 4))
    )
    .sort(
      (a, b) =>
        (a.hits ?? 0) / (a.maxHits ?? 1) -
        pressure(a) * 0.12 -
        ((a.flags ?? 0) & 4 ? 0.2 : 0) -
        ((b.hits ?? 0) / (b.maxHits ?? 1) - pressure(b) * 0.12 - ((b.flags ?? 0) & 4 ? 0.2 : 0))
    )[0];
}

const refreshed = new WeakMap<PlayerSession, number>();
export async function refreshAllyHealth(session: PlayerSession) {
  if (Date.now() - (refreshed.get(session) ?? 0) < 3000) return;
  const stale = visibleAllies(session).find((e) => !e.healthAt || Date.now() - e.healthAt > 5000);
  if (!stale) return;
  refreshed.set(session, Date.now());
  await session.inspect(stale.serial).catch(() => {});
}

export function groupPositionCost(
  session: PlayerSession,
  point: { x: number; y: number },
  opponent: Entity,
  now = Date.now()
): number {
  if (!opponent.position) return 0;
  const swing = session.world.swings.get(opponent.serial);
  const tank =
    swing && now - swing.at >= 0 && now - swing.at < 6000
      ? visibleAllies(session).find(
          (e) => e.serial === swing.target && e.hits !== undefined && e.maxHits && e.hits / e.maxHits >= 0.5
        )
      : undefined;
  if (!tank?.position) return 0;
  const enemy = opponent.position,
    front = tank.position;
  const dot = (point.x - enemy.x) * (front.x - enemy.x) + (point.y - enemy.y) * (front.y - enemy.y);
  return (dot < 0 ? 12 : 0) + Math.max(0, distance(point, front) - 8) * 2;
}
