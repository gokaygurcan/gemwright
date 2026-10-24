import { readFileSync } from 'node:fs';

import { HUMAN_BODIES } from './bodies';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// What a resident who does not fight avoids: creatures that attack on sight (their ServUO FightMode,
// catalogs/aggressive-bodies.json from build-aggression.ts; a body shared with passive creatures is
// judged by the creature's name), criminals and murderers in human form,
// and anything already attacking it. Vendors, passive animals and pets are company, not danger.
// Young characters are spared attacks, but a resident works as if it were not young. Threats seen
// are remembered by 16-tile area for 20 minutes, since monsters wander out of view and back.
const catalog = JSON.parse(readFileSync(new URL('../catalogs/aggressive-bodies.json', import.meta.url), 'utf8')) as {
  bodies: number[];
  shared: Record<string, { names: string[]; hostile: boolean }>;
};
const aggressive = new Set(catalog.bodies);
// A body passive creatures share (a cat, a hell cat) is judged by name; unnamed, by its default.
// An unnamed one is asked about once, as a player hovering over it would.
const asked = new WeakMap<PlayerSession, Set<number>>();
const sharedThreat = (session: PlayerSession, mobile: Entity) => {
  const shared = catalog.shared[mobile.graphic];
  if (!shared) return false;
  const name = mobile.name?.toLowerCase();
  if (name) return shared.names.includes(name);
  const done = asked.get(session) ?? new Set<number>();
  asked.set(session, done);
  if (!done.has(mobile.serial) && done.size < 2000) {
    done.add(mobile.serial);
    void session.inspect(mobile.serial).catch(() => {});
  }
  return shared.hostile;
};
const humans = HUMAN_BODIES;
const hostile = (session: PlayerSession, mobile: Entity) =>
  mobile.kind === 'mobile' &&
  mobile.serial !== session.world.serial &&
  (mobile.serial === session.world.combatant ||
    (humans.has(mobile.graphic)
      ? [4, 5, 6].includes(mobile.notoriety ?? 0)
      : (aggressive.has(mobile.graphic) || sharedThreat(session, mobile)) &&
        [3, 4, 5, 6].includes(mobile.notoriety ?? 0)));
const REMEMBER_MS = 20 * 60_000;
const remembered = new WeakMap<PlayerSession, Map<string, number>>();
const cell = (point: { x: number; y: number }) => `${point.x >> 4},${point.y >> 4}`;

export function threatsNear(session: PlayerSession, point: { x: number; y: number }, radius: number) {
  const seen = remembered.get(session) ?? new Map<string, number>();
  remembered.set(session, seen);
  const threats = [...session.world.entities.values()].filter(
    (mobile) => hostile(session, mobile) && !!mobile.position && !session.world.deaths.has(mobile.serial)
  );
  for (const threat of threats) if (threat.position) seen.set(cell(threat.position), Date.now() + REMEMBER_MS);
  return threats.filter((threat) => threat.position && distance(point, threat.position) <= radius);
}

// A check for many candidate spots: unsafe with a threat within ten tiles, or in an area where
// one was lately seen. Threats are read once, when the check is made.
export function unsafeCheck(session: PlayerSession) {
  const threats = threatsNear(session, session.world.position ?? { x: 0, y: 0 }, Number.POSITIVE_INFINITY);
  const seen = remembered.get(session);
  return (point: { x: number; y: number }) =>
    (seen?.get(cell(point)) ?? 0) > Date.now() ||
    threats.some((threat) => threat.position && distance(point, threat.position) <= 10);
}
