import { directRoute } from './direct-route';
import { type RouteRequest, type RouteResult, RouteSearch } from './path-search';
import { RouteWaypoints } from './route-waypoints';
import type { Point, Terrain } from './terrain';

// Full city routes are reusable public-terrain corridors; join them with a small local search.
export class RouteCorridors {
  private readonly routes = new Map<string, Point[]>();
  private readonly search = new RouteSearch();
  private readonly waypoints = new RouteWaypoints();
  run(terrain: Terrain, request: RouteRequest, cancelled: () => boolean): RouteResult {
    const began = performance.now();
    const blocked = new Set(request.blocked);
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const key = `${request.goal.x},${request.goal.y},${request.range},${request.targetZ ?? ''}`;
    // A long walk joins the public road corridors first; a straight line is for short stretches.
    if (distance(request.start, request.goal) > 96) {
      const local = this.waypoints.run(terrain, request, this.search, cancelled);
      if (local) return { ...local, elapsedMs: performance.now() - began };
    }
    const direct = directRoute(terrain, request.start, request.goal, request.range, blocked, request.targetZ, 1024);
    if (direct && distance(direct.at(-1) ?? request.start, request.goal) <= request.range)
      return { path: direct, expanded: 0, exhausted: false, elapsedMs: performance.now() - began };
    const corridor = this.routes.get(key);
    if (corridor && !corridor.some((p) => blocked.has(`${p.x},${p.y}`))) {
      let index = -1;
      let best = 49;
      for (const [i, point] of corridor.entries()) {
        const d = distance(request.start, point);
        if (d <= best) {
          best = d;
          index = i;
        }
      }
      const join = corridor[index];
      if (join) {
        const prefix = this.search.run(
          terrain,
          { ...request, goal: join, targetZ: join.z, range: 0, partial: false },
          cancelled
        );
        if (prefix.path)
          return {
            ...prefix,
            path: [...prefix.path, ...corridor.slice(index + 1)],
            elapsedMs: performance.now() - began
          };
      }
    }
    const result = this.search.run(terrain, request, cancelled);
    const end = result.path?.at(-1) ?? request.start;
    if (
      result.path &&
      result.path.length > 64 &&
      distance(end, request.goal) <= request.range &&
      (request.targetZ === undefined || Math.abs(end.z - request.targetZ) <= 8)
    ) {
      const oldest = this.routes.keys().next().value;
      if (this.routes.size >= 64 && oldest !== undefined) this.routes.delete(oldest);
      this.routes.set(key, result.path);
    }
    return result;
  }
}
