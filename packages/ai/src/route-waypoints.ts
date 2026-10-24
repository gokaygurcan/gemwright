import { readFileSync } from 'node:fs';

import type { RouteRequest, RouteResult, RouteSearch } from './path-search';
import type { Point, Terrain } from './terrain';

interface Corridor {
  name: string;
  both: boolean;
  points: number[][];
}
const publicRoutes = JSON.parse(
  readFileSync(new URL('../locations/route-corridors.json', import.meta.url), 'utf8')
) as { facet: number; corridors: Corridor[] };
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const point = (row: number[]): Point => ({ x: row[0] ?? 0, y: row[1] ?? 0, z: row[2] ?? 0 });

export class RouteWaypoints {
  constructor(private readonly corridors: Corridor[] = publicRoutes.corridors) {}
  run(terrain: Terrain, request: RouteRequest, search: RouteSearch, cancelled: () => boolean): RouteResult | null {
    if (!request.partial || terrain.facet !== publicRoutes.facet) return null;
    const remaining = distance(request.start, request.goal);
    const choices: { join: Point; next: Point; score: number }[] = [];
    for (const corridor of this.corridors) {
      for (const rows of corridor.both ? [corridor.points, [...corridor.points].reverse()] : [corridor.points]) {
        const last = rows.at(-1);
        if (!last) continue;
        const end = point(last);
        if (distance(end, request.goal) >= remaining - 8) continue;
        for (let i = 0; i < rows.length - 1; i++) {
          const row = rows[i];
          const following = rows[i + 1];
          if (!row || !following) continue;
          const join = point(row);
          const d = distance(request.start, join);
          if (d > 128) continue;
          choices.push({ join, next: point(following), score: d + distance(end, request.goal) * 0.05 });
        }
      }
    }
    choices.sort((a, b) => a.score - b.score);
    for (const choice of choices.slice(0, 4)) {
      if (cancelled()) return null;
      const joined = search.run(
        terrain,
        { ...request, goal: choice.join, range: 0, targetZ: choice.join.z, partial: false },
        cancelled
      );
      if (!joined.path) continue;
      const start = joined.path.at(-1) ?? request.start;
      const onward = search.run(
        terrain,
        { ...request, start, goal: choice.next, range: 0, targetZ: choice.next.z, partial: false },
        cancelled
      );
      if (onward.path?.length)
        return {
          ...onward,
          path: [...joined.path, ...onward.path],
          expanded: joined.expanded + onward.expanded,
          elapsedMs: joined.elapsedMs + onward.elapsedMs
        };
    }
    return null;
  }
}
