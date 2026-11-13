import type { Route, WalkGraph } from '../walk-graph';
import { CELL, type Ground, type Spot } from '../walk-graph-build';

// What it knows of the way to places (walk-graph.ts): whether there is one, how many steps, and its
// legs. On foot, by teleporter and by public moongate. The steps to
// everywhere are measured once per 32-tile cell it stands in, and each place's once from there.
export class Reach {
  private here?: { cell: number; to: (spot: Spot) => number; known: Map<number, number | undefined> };

  private previous?: Reach['here'];

  constructor(
    private readonly graph: WalkGraph,
    private readonly terrain: Ground
  ) {}

  // A spot one can stand on: the height there nearest the one given, within a few tiles if the spot
  // itself is not standable (a spawner's centre inside a wall).
  stand(spot: { x: number; y: number; z: number }): Spot | undefined {
    for (let radius = 0; radius <= 3; radius++)
      for (let dx = -radius; dx <= radius; dx++)
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = spot.x + dx;
          const y = spot.y + dy;
          if (x < 1 || y < 1 || x > 7165 || y > 4093) continue;
          const z =
            this.terrain.standingZ(x, y, spot.z) ?? this.terrain.standingZ(x, y, this.terrain.cell(x, y).land.z);
          if (z !== undefined) return { x, y, z };
        }
    return undefined;
  }

  steps = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
    const cell = Math.floor(from.x / CELL) * 1024 + Math.floor(from.y / CELL);
    if (this.here?.cell !== cell && this.previous?.cell === cell)
      [this.here, this.previous] = [this.previous, this.here];
    if (this.here?.cell !== cell) {
      const start = this.stand(from);
      if (!start) return undefined;
      this.previous = this.here;
      this.here = { cell, to: this.graph.from(start), known: new Map() };
    }
    const key = to.x * 4096 + to.y;
    if (!this.here.known.has(key)) {
      const end = this.stand(to);
      const steps = end ? this.here.to(end) : Number.POSITIVE_INFINITY;
      this.here.known.set(key, Number.isFinite(steps) ? steps : undefined);
    }
    return this.here.known.get(key);
  };

  // The way from one spot to another, a little different each trip (`seed`), or nothing.
  route(from: Spot, to: { x: number; y: number; z: number }, seed: number): Route | undefined {
    const start = this.stand(from);
    const end = this.stand(to);
    return start && end ? this.graph.route(start, end, undefined, seed) : undefined;
  }
}

// The way the land joins up, shared by every resident (serve.ts loads it once).
let land: WalkGraph | undefined;
export const useLand = (graph: WalkGraph) => {
  land = graph;
};
export const landGraph = () => land;
// Each resident's own reach over it (each stands somewhere else), or nothing before it is known.
export const reachOver = (terrain: Ground) => (land ? new Reach(land, terrain) : undefined);
