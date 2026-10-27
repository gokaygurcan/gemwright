// biome-ignore-all lint/style/noNonNullAssertion: typed-array reads in the A* inner loop; every index is bounded by how the search arrays are built, and a fallback per read would cost the hottest code in the AI.
import type { Point, Terrain } from './terrain';

export interface RouteRequest {
  start: Point;
  goal: { x: number; y: number };
  range: number;
  blocked: string[];
  // 8-tile cells where walks keep failing (trouble.ts): each step there costs more.
  penalties?: number[];
  penaltyCost?: number;
  wide?: boolean;
  targetZ?: number;
  partial?: boolean;
}
export interface RouteResult {
  path: Point[] | null;
  expanded: number;
  exhausted: boolean;
  elapsedMs: number;
}
const directions = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
] as const;
const coordinate = (x: number, y: number, z: number) => (x * 4096 + y) * 512 + z + 256;
// Land tiles that read as a road or path, by tile id; tile names do not change while running.
const roads = new Map<number, boolean>();
const isRoad = (terrain: Pick<Terrain, 'tile'>, id: number) => {
  let road = roads.get(id);
  if (road === undefined) {
    road = /cobble|flagstone|pavement|paver|road|dirt/i.test(terrain.tile(id).name);
    roads.set(id, road);
  }
  return road;
};

// One reusable workspace per worker. Both the discovered set and heap have a hard bound.
export class RouteSearch {
  private readonly keys: Float64Array;
  private readonly x: Uint16Array;
  private readonly y: Uint16Array;
  private readonly z: Int16Array;
  private readonly costs: Float64Array;
  private readonly ranks: Float64Array;
  private readonly parents: Int32Array;
  private readonly positions: Int32Array;
  private readonly hash: Uint32Array;
  private readonly heap: Uint32Array;
  private readonly hashSize: number;
  private count = 0;
  private size = 0;

  constructor(
    private readonly capacity = 65536,
    private readonly budgetMs = 500,
    private readonly expansionBudget?: number,
    // Cost of a step off the road; live searches prefer roads mildly, the offline corridor build
    // (build-routes.ts) strongly, so stored town-to-town routes follow the actual roads.
    private readonly offRoad = 1.12
  ) {
    if (!Number.isInteger(capacity) || capacity < 1024 || capacity > 1048576 || capacity & (capacity - 1))
      throw new Error('Search capacity must be a power of two from 1024 to 1048576');
    this.hashSize = capacity * 4;
    this.keys = new Float64Array(capacity);
    this.x = new Uint16Array(capacity);
    this.y = new Uint16Array(capacity);
    this.z = new Int16Array(capacity);
    this.costs = new Float64Array(capacity);
    this.ranks = new Float64Array(capacity);
    this.parents = new Int32Array(capacity);
    this.positions = new Int32Array(capacity);
    this.hash = new Uint32Array(capacity * 4);
    this.heap = new Uint32Array(capacity);
  }

  private slot(key: number) {
    let hash = (key | 0) ^ Math.floor(key / 4294967296);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    let slot = (hash ^ (hash >>> 16)) >>> 0;
    slot &= this.hashSize - 1;
    while (this.hash[slot] && this.keys[(this.hash[slot] ?? 1) - 1] !== key) slot = (slot + 1) & (this.hashSize - 1);
    return slot;
  }
  private point(index: number): Point {
    return { x: this.x[index]!, y: this.y[index]!, z: this.z[index]! };
  }
  private push(index: number) {
    let at = this.positions[index]!;
    if (at < 0) at = this.size++;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      const other = this.heap[parent]!;
      if (this.ranks[other]! <= this.ranks[index]!) break;
      this.heap[at] = other;
      this.positions[other] = at;
      at = parent;
    }
    this.heap[at] = index;
    this.positions[index] = at;
  }
  private pop() {
    const first = this.heap[0]!;
    const last = this.heap[--this.size]!;
    if (this.size) {
      let at = 0;
      while (at * 2 + 1 < this.size) {
        let child = at * 2 + 1;
        if (child + 1 < this.size && this.ranks[this.heap[child + 1]!]! < this.ranks[this.heap[child]!]!) child++;
        const other = this.heap[child]!;
        if (this.ranks[other]! >= this.ranks[last]!) break;
        this.heap[at] = other;
        this.positions[other] = at;
        at = child;
      }
      this.heap[at] = last;
      this.positions[last] = at;
    }
    this.positions[first] = -1;
    return first;
  }
  run(
    terrain: Pick<Terrain, 'stand' | 'cell' | 'tile'> & Partial<Pick<Terrain, 'standingZ'>>,
    request: RouteRequest,
    cancelled = () => false
  ): RouteResult {
    const began = performance.now();
    this.hash.fill(0);
    this.positions.fill(-1);
    this.count = 1;
    this.size = 0;
    const { start, goal, range, targetZ } = request;
    const blocked = new Set(request.blocked);
    const penalties = new Set(request.penalties ?? []);
    const estimate = (x: number, y: number) => {
      const dx = Math.abs(x - goal.x),
        dy = Math.abs(y - goal.y);
      return (Math.max(dx, dy) + 0.4 * Math.min(dx, dy)) * 1.1;
    };
    const distance = (x: number, y: number) => Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y));
    const add = (index: number, point: Point, key: number, slot: number) => {
      this.keys[index] = key;
      this.x[index] = point.x;
      this.y[index] = point.y;
      this.z[index] = point.z;
      this.hash[slot] = index + 1;
    };
    const key = coordinate(start.x, start.y, start.z);
    add(0, start, key, this.slot(key));
    this.parents[0] = -1;
    this.costs[0] = 0;
    this.ranks[0] = estimate(start.x, start.y);
    this.push(0);
    let expanded = 0;
    let best = 0;
    let found = -1;
    let exhausted = false;
    // Near goals get a small budget; `wide` asks for the full one (a short way that needs a long
    // detour round a wall or a river, retried by terrain.ts).
    const expansionLimit = this.expansionBudget ?? (distance(start.x, start.y) <= 38 && !request.wide ? 8192 : 200000);
    const current: Point = { ...start };
    const height = (x: number, y: number) =>
      terrain.standingZ ? terrain.standingZ(x, y, current.z, current) : terrain.stand(x, y, current.z, current)?.z;
    outer: while (this.size && expanded < expansionLimit) {
      if ((expanded & 63) === 0 && (cancelled() || performance.now() - began > this.budgetMs)) {
        exhausted = true;
        break;
      }
      const index = this.pop();
      current.x = this.x[index]!;
      current.y = this.y[index]!;
      current.z = this.z[index]!;
      expanded++;
      const d = distance(current.x, current.y);
      if (d < distance(this.x[best]!, this.y[best]!)) best = index;
      if (d <= range && (targetZ === undefined || Math.abs(current.z - targetZ) <= 8)) {
        found = index;
        break;
      }
      for (const [dx, dy] of directions) {
        const x = current.x + dx;
        const y = current.y + dy;
        if (x < 1 || y < 1 || x > 7165 || y > 4093 || blocked.has(`${x},${y}`)) continue;
        const nextZ = height(x, y);
        if (
          nextZ === undefined ||
          (dx && dy && (height(x, current.y) === undefined || height(current.x, y) === undefined))
        )
          continue;
        const key = coordinate(x, y, nextZ);
        const slot = this.slot(key);
        let other = this.hash[slot]! - 1;
        const road = isRoad(terrain, terrain.cell(x, y).land.id);
        const parent = this.parents[index]!;
        const turn =
          parent >= 0 &&
          (Math.sign(current.x - this.x[parent]!) !== dx || Math.sign(current.y - this.y[parent]!) !== dy);
        const trouble = penalties.size && penalties.has((x >> 3) * 1024 + (y >> 3)) ? (request.penaltyCost ?? 4) : 0;
        const cost =
          this.costs[index]! + (dx && dy ? 1.4 : 1) * (road ? 1 : this.offRoad) + (turn ? 0.08 : 0) + trouble;
        if (other >= 0 && this.costs[other]! <= cost) continue;
        if (other < 0) {
          if (this.count === this.capacity) {
            exhausted = true;
            break outer;
          }
          other = this.count++;
          add(other, { x, y, z: nextZ }, key, slot);
        }
        this.costs[other] = cost;
        this.ranks[other] = cost + estimate(x, y);
        this.parents[other] = index;
        this.push(other);
      }
    }
    if (expanded >= expansionLimit) exhausted = true;
    if (cancelled()) return { path: null, expanded, exhausted, elapsedMs: performance.now() - began };
    if (found < 0 && request.partial && distance(this.x[best]!, this.y[best]!) < distance(start.x, start.y) - 8)
      found = best;
    let path: Point[] | null = null;
    if (found >= 0) {
      path = [];
      for (
        let index = found, steps = 0;
        this.parents[index]! >= 0 && steps < this.capacity;
        steps++, index = this.parents[index]!
      )
        path.push(this.point(index));
      path.reverse();
    }
    return { path, expanded, exhausted, elapsedMs: performance.now() - began };
  }
}
