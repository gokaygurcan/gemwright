import { HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import type { PlayerSession } from '@gemwright/network/session';

import { unsafeCheck } from './danger';
import { miningCatalog } from './mining-catalog';
import { distance } from './navigation';
import { residentContext } from './resident-context';
import { learnedPlaceCost } from './strategy-learning';
import type { Point, Terrain } from './terrain';

// Chooses the next mining spot: walkable rock, cave land, or cave-floor statics near the miner,
// biased toward its personal anchor, away from depleted veins and from spots others are working.
export async function findMiningSite(options: {
  session: PlayerSession;
  terrain: Terrain;
  serial: number;
  position: () => Point;
  check: () => void;
  exhausted: { has: (key: string) => boolean };
  blocked: Set<string>;
  miningArea: { x: number; y: number } | null;
  anchor: { x: number; y: number } | null;
}) {
  const { session, terrain, serial, position, check, exhausted, blocked, miningArea, anchor } = options;
  const origin = position();
  // Other people already working a spot: a player picks a free rock instead.
  const people = [...session.world.entities.values()].filter(
    (mobile) =>
      mobile.kind === 'mobile' && mobile.serial !== serial && HUMAN_ELF_BODIES.has(mobile.graphic) && mobile.position
  );
  const crowding = (point: { x: number; y: number }) =>
    people.some((mobile) => mobile.position && distance(mobile.position, point) <= 4) ? 40 : 0;
  // Rocks within reach of monsters, or where they were lately seen, are left alone (danger.ts).
  const risky = unsafeCheck(session);
  // Empty veins come in neighbourhoods: miners sharing a mountain strip whole stretches, and ore
  // respawns ten to twenty minutes later (ServUO Mining.cs). Each empty 8x8 vein within two veins
  // of a rock counts against it, so after an empty one the miner moves to fresh ground instead of
  // trying every block next door in turn.
  const depletedAround = (point: { x: number; y: number }) => {
    let count = 0;
    for (let bx = (point.x >> 3) - 2; bx <= (point.x >> 3) + 2; bx++)
      for (let by = (point.y >> 3) - 2; by <= (point.y >> 3) + 2; by++) if (exhausted.has(`${bx},${by}`)) count++;
    return count;
  };
  const candidates = (await miningCatalog(terrain, origin, miningArea))
    .filter(
      (point) =>
        distance(origin, point) <= 180 &&
        !risky(point) &&
        !exhausted.has(`${point.x >> 3},${point.y >> 3}`) &&
        !exhausted.has(`tile:${point.x},${point.y}`)
    )
    .map((point) => ({
      ...point,
      score:
        distance(origin, point) +
        learnedPlaceCost(residentContext(session)?.checkpoint, session.world.map ?? 1, point) +
        (anchor ? distance(point, anchor) * 0.4 : 0) +
        crowding(point) +
        depletedAround(point) * 12 -
        (point.floor ? 18 : 0)
    }));
  check();
  candidates.sort((a, b) => a.score - b.score);
  let site: (typeof candidates)[number] | undefined;
  let approachRange = 1;
  const rockRange = Math.random() < 0.9 ? 1 : 2;
  const floorRange = Math.random() < 0.8 ? 0 : 1;
  const rejectedBanks = new Set<string>();
  let routeAttempts = 0;
  for (const candidate of candidates.slice(0, 1000)) {
    check();
    const bankKey = `${candidate.x >> 3},${candidate.y >> 3}`;
    if (rejectedBanks.has(bankKey)) continue;
    const range = candidate.floor ? floorRange : rockRange;
    let nearbyStandingTile = false;
    for (let dx = -range; dx <= range && !nearbyStandingTile; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        const point = terrain.stand(candidate.x + dx, candidate.y + dy, candidate.z);
        if (point && Math.abs(point.z - candidate.z) <= 10) {
          nearbyStandingTile = true;
          break;
        }
      }
    }
    if (!nearbyStandingTile) continue;
    if (++routeAttempts > 32) break;
    const path = await terrain.pathAsync(
      origin,
      candidate,
      range,
      blocked,
      candidate.floor ? candidate.z : undefined,
      session.signal
    );
    if (path && Math.abs((path.at(-1) ?? origin).z - candidate.z) <= 10) {
      site = candidate;
      approachRange = range;
      break;
    }
    rejectedBanks.add(bankKey);
    await Bun.sleep(0);
  }
  return site ? { site, approachRange } : null;
}
