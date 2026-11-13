import type { Corridor } from '../route-waypoints';

// A public road (v1/route-build.ts corridors: a town's bank to its moongate, to its mines and woods,
// and to the nearest other towns), as one standing on it knows it: its two ends, which of them it
// is facing, and what lies along it.
export interface OnRoad {
  from: string;
  to: string;
  toward?: string;
  along: string[];
}

// Two tiles either side of a road's line are on it.
const WIDTH = 2;
// UO facing (0 north, clockwise): the step it points along.
const facing = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
];

// A road end as a player calls it: a town's bank is the town, a gate the moongate, work grounds the
// town they belong to.
const end = (hub: string) => {
  const [kind = '', ...rest] = hub.split(':');
  if (kind === 'bank') return rest.join(':');
  if (kind === 'gate') return `${rest.join(':')} moongate`;
  if (kind === 'work') return `${rest[0]} grounds`;
  return hub;
};

export class Roads {
  private readonly tiles = new Map<number, { road: number; index: number }>();
  private readonly roads: { from: string; to: string; along: string[]; points: number[][] }[] = [];

  // `named` names what lies at a spot along a road (a town, a dungeon entrance), if anything.
  constructor(corridors: readonly Corridor[], named: (x: number, y: number) => string | undefined = () => undefined) {
    for (const corridor of corridors) {
      const [a = '', b = ''] = corridor.name.split('-');
      const road = this.roads.length;
      const along = new Set<string>();
      corridor.points.forEach((point, index) => {
        const next = corridor.points[index + 1] ?? point;
        const [x0 = 0, y0 = 0] = point;
        const [x1 = 0, y1 = 0] = next;
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let s = 0; s <= steps; s++) {
          const x = Math.round(x0 + ((x1 - x0) * s) / steps);
          const y = Math.round(y0 + ((y1 - y0) * s) / steps);
          for (let dx = -WIDTH; dx <= WIDTH; dx++)
            for (let dy = -WIDTH; dy <= WIDTH; dy++)
              if (!this.tiles.has((x + dx) * 4096 + y + dy)) this.tiles.set((x + dx) * 4096 + y + dy, { road, index });
          const name = s % 8 === 0 ? named(x, y) : undefined;
          if (name) along.add(name);
        }
      });
      this.roads.push({ from: end(a), to: end(b), along: [...along], points: corridor.points });
    }
  }

  // The road a spot is on, if any, and which end it faces.
  on(p: { x: number; y: number; direction?: number }): OnRoad | undefined {
    const tile = this.tiles.get(p.x * 4096 + p.y);
    if (!tile) return undefined;
    const road = this.roads[tile.road];
    if (!road) return undefined;
    const ahead = road.points[Math.min(road.points.length - 1, tile.index + 1)];
    const here = road.points[tile.index];
    const step = p.direction === undefined ? undefined : facing[p.direction & 7];
    const toward =
      step && ahead && here
        ? (step[0] ?? 0) * ((ahead[0] ?? 0) - (here[0] ?? 0)) + (step[1] ?? 0) * ((ahead[1] ?? 0) - (here[1] ?? 0)) >= 0
          ? road.to
          : road.from
        : undefined;
    return { from: road.from, to: road.to, ...(toward ? { toward } : {}), along: road.along };
  }
}
