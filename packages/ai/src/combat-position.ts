import { groupPositionCost } from './group-awareness';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position } from './protocol/world';
import type { Terrain } from './terrain';

export function positionScore(
  point: { x: number; y: number },
  target: { x: number; y: number },
  threats: readonly Entity[],
  range: number,
  origin: { x: number; y: number }
): number {
  const gap = distance(point, target);
  if (gap < 3 || gap > range) return Infinity;
  if (threats.some((threat) => threat.position && distance(point, threat.position) < 4)) return Infinity;
  return Math.abs(gap - Math.max(4, range - 2)) * 2 + distance(origin, point) * 0.5;
}

// Public map geometry is a conservative filter, never proof the server will accept a shot.
export function clearShot(
  terrain: Terrain,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
) {
  const steps = distance(from, to);
  for (let step = 1; step < steps; step++) {
    const ratio = step / steps;
    const x = Math.round(from.x + (to.x - from.x) * ratio);
    const y = Math.round(from.y + (to.y - from.y) * ratio);
    const eye = from.z + 14 + (to.z - from.z) * ratio;
    if (
      terrain.cell(x, y).statics.some((item) => {
        const tile = terrain.tile(item.id, true);
        return !!(tile.flags & 0x2000) && item.z <= eye && item.z + Math.max(1, tile.height) >= eye;
      })
    )
      return false;
  }
  return true;
}

export async function combatPosition(options: {
  session: PlayerSession;
  terrain: Terrain;
  origin: Position;
  target: Entity;
  threats: Entity[];
  range: number;
  check: () => void;
}) {
  const { session, terrain, origin, target, threats, range, check } = options;
  if (!target.position) return undefined;
  const occupied = new Set(
    [...session.world.entities.values()].flatMap((entity) =>
      entity.kind === 'mobile' && entity.serial !== session.world.serial && entity.position
        ? [`${entity.position.x},${entity.position.y}`]
        : []
    )
  );
  const candidates = [];
  for (const radius of [0, 2, 4])
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1]
    ]) {
      const point = terrain.stand(origin.x + (dx ?? 0) * radius, origin.y + (dy ?? 0) * radius, origin.z);
      if (!point || occupied.has(`${point.x},${point.y}`) || !clearShot(terrain, point, target.position)) continue;
      const score =
        positionScore(point, target.position, threats, range, origin) + groupPositionCost(session, point, target);
      if (Number.isFinite(score)) candidates.push({ point, score });
      if (radius === 0) break;
    }
  candidates.sort((a, b) => a.score - b.score);
  for (const { point } of candidates.slice(0, 4)) {
    check();
    if (distance(origin, point) === 0) return point;
    const path = await terrain.pathAsync(origin, point, 0, occupied, point.z, session.signal);
    if (
      path?.length &&
      path.length <= 10 &&
      !path.some((step) => threats.some((threat) => threat.position && distance(step, threat.position) < 3))
    )
      return point;
  }
  return undefined;
}
