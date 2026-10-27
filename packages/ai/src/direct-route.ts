import { teleporterTiles } from './links';
import type { Point, Terrain } from './terrain';

const teleporters = new Set(teleporterTiles);

// Most travel is an unobstructed stretch. Reserve A* for the obstacle ahead.
export function directRoute(
  terrain: Pick<Terrain, 'stand'>,
  start: Point,
  goal: { x: number; y: number },
  range: number,
  blocked: ReadonlySet<string>,
  targetZ?: number,
  limit = 32
): Point[] | null {
  const path: Point[] = [];
  let point = start;
  for (let step = 0; step < limit; step++) {
    const distance = Math.max(Math.abs(point.x - goal.x), Math.abs(point.y - goal.y));
    if (distance <= range) return targetZ === undefined || Math.abs(point.z - targetZ) <= 8 ? path : null;
    const dx = Math.sign(goal.x - point.x);
    const dy = Math.sign(goal.y - point.y);
    const x = point.x + dx;
    const y = point.y + dy;
    // A teleporter is stepped on only as the goal itself (links.ts).
    if (blocked.has(`${x},${y}`) || (teleporters.has(`${x},${y}`) && (x !== goal.x || y !== goal.y))) break;
    const next = terrain.stand(x, y, point.z, point);
    if (
      !next ||
      (dx && dy && (!terrain.stand(x, point.y, point.z, point) || !terrain.stand(point.x, y, point.z, point)))
    )
      break;
    path.push(next);
    point = next;
  }
  return path.length ? path : null;
}
