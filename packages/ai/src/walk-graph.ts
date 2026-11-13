import { CELL, type Ground, type Spot, spotKey, type WalkGraphData, walkInCell } from './walk-graph-build';

// One leg of a route: walking to a spot, stepping onto a teleporter there, or taking the moongate
// there to the named gate.
export type Leg =
  | { kind: 'walk'; x: number; y: number; z: number }
  | { kind: 'teleport'; x: number; y: number; z: number }
  | { kind: 'gate'; x: number; y: number; z: number; to: string };
export interface Route {
  steps: number;
  legs: Leg[];
}

const LANDMARKS = 16;
const chebyshev = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
// Whether a place can be reached and how (walk-graph-build.ts): on foot, through which teleporters,
// by which moongates, and about how many steps. A spot joins the graph at every node of its own cell
// it can walk to without leaving the cell; the search is A* over the graph, its estimate never more
// than the steps left (the straight-line steps, or the steps to the nearest teleporter or gate plus
// the least any of them saves). A `seed` makes each edge up to a quarter longer, the same for one
// trip and different for another, so two near-equal ways are each taken now and then, as people do.
export class WalkGraph {
  private readonly first: Int32Array;
  private readonly next: Int32Array;
  private readonly cost: Uint16Array;
  readonly data: Pick<WalkGraphData, 'x' | 'y' | 'z' | 'kind' | 'gates'>;
  private readonly byCell = new Map<number, Map<number, number>>();
  private readonly gateName = new Map<number, string>();
  private readonly portals: number[] = [];
  // Each node's straight-line steps to the nearest teleporter entrance or gate.
  private readonly nearPortal: Float64Array;
  private readonly distance: Float64Array;
  private readonly parent: Int32Array;
  private readonly heap: Int32Array;
  private readonly rank: Float64Array;
  private readonly position: Int32Array;
  // Each spot's steps, as asked: the land does not change. Emptied past a bound on its size.
  private readonly known = new Map<number, Spot[]>();
  // Landmarks spread across the graph and the exact steps from each to every node and from every
  // node to each (all gates open, no variation): by the triangle inequality, a lower bound on the
  // steps between any two nodes that teleporters and gates cannot undercut.
  private readonly fromMark: Float32Array[] = [];
  // Which pieces of the graph any edges join at all (either way, every gate open): two spots in
  // different ones have no way between them, whatever gates are open.
  private readonly group: Int32Array;
  private readonly toMark: Float32Array[] = [];
  // Which pieces join up on foot alone, no teleporter or gate taken: an island, a dungeon level.
  readonly land: Int32Array;
  // Each teleporter's and gate's jump: the node stepped on, the node it puts one on.
  readonly jumps: { from: number; to: number }[] = [];

  constructor(
    graph: WalkGraphData,
    private readonly terrain: Ground,
    // Teleporter entrance tiles (`x * 4096 + y`): never walked over.
    private readonly closed: ReadonlySet<number> = new Set()
  ) {
    const { from, to, cost, ...data } = graph;
    this.data = data;
    const count = data.x.length;
    this.first = new Int32Array(count + 1);
    for (const a of from) this.first[a + 1] = (this.first[a + 1] ?? 0) + 1;
    for (let i = 0; i < count; i++) this.first[i + 1] = (this.first[i + 1] ?? 0) + (this.first[i] ?? 0);
    const fill = this.first.slice(0, count);
    this.next = new Int32Array(from.length);
    this.cost = new Uint16Array(from.length);
    from.forEach((a, i) => {
      const at = fill[a] ?? 0;
      fill[a] = at + 1;
      this.next[at] = to[i] ?? 0;
      this.cost[at] = cost[i] ?? 0;
    });
    for (let i = 0; i < count; i++) {
      const cell = this.cellOf(data.x[i] ?? 0, data.y[i] ?? 0);
      const members = this.byCell.get(cell) ?? new Map<number, number>();
      members.set(spotKey(this.spot(i)), i);
      this.byCell.set(cell, members);
      if (data.kind[i] !== 0) this.portals.push(i);
    }
    for (const [name, id] of Object.entries(data.gates)) this.gateName.set(id, name);
    this.nearPortal = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    for (let i = 0; i < count; i++)
      for (const p of this.portals) {
        const d = chebyshev(data.x[i] ?? 0, data.y[i] ?? 0, data.x[p] ?? 0, data.y[p] ?? 0);
        if (d < (this.nearPortal[i] ?? 0)) this.nearPortal[i] = d;
      }
    this.distance = new Float64Array(count);
    this.parent = new Int32Array(count);
    this.heap = new Int32Array(count + 2);
    this.rank = new Float64Array(count);
    this.position = new Int32Array(count);
    this.group = Int32Array.from({ length: count }, (_, i) => i);
    const root = (i: number): number => {
      while (this.group[i] !== i) {
        this.group[i] = this.group[this.group[i] ?? i] ?? i;
        i = this.group[i] ?? i;
      }
      return i;
    };
    from.forEach((a, i) => {
      const ra = root(a);
      const rb = root(to[i] ?? 0);
      if (ra !== rb) this.group[ra] = rb;
    });
    for (let i = 0; i < count; i++) this.group[i] = root(i);
    this.land = Int32Array.from({ length: count }, (_, i) => i);
    const landOf = (i: number): number => {
      while (this.land[i] !== i) {
        this.land[i] = this.land[this.land[i] ?? i] ?? i;
        i = this.land[i] ?? i;
      }
      return i;
    };
    from.forEach((a, i) => {
      const b = to[i] ?? 0;
      if (data.kind[a]) {
        this.jumps.push({ from: a, to: b });
        return;
      }
      const ra = landOf(a);
      const rb = landOf(b);
      if (ra !== rb) this.land[ra] = rb;
    });
    for (let i = 0; i < count; i++) this.land[i] = landOf(i);
    // The same edges reversed, for the steps from every node to a landmark.
    const back = {
      first: new Int32Array(count + 1),
      next: new Int32Array(to.length),
      cost: new Uint16Array(to.length)
    };
    for (const b of to) back.first[b + 1] = (back.first[b + 1] ?? 0) + 1;
    for (let i = 0; i < count; i++) back.first[i + 1] = (back.first[i + 1] ?? 0) + (back.first[i] ?? 0);
    const place = back.first.slice(0, count);
    to.forEach((b, i) => {
      const at = place[b] ?? 0;
      place[b] = at + 1;
      back.next[at] = from[i] ?? 0;
      back.cost[at] = cost[i] ?? 0;
    });
    // Each next landmark the node farthest from those already chosen (over every node any reaches).
    const forward = { first: this.first, next: this.next, cost: this.cost };
    const nearest = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
    let mark = 0;
    for (let i = 0; i < LANDMARKS && count; i++) {
      const out = this.everywhere(mark, forward);
      this.fromMark.push(out);
      this.toMark.push(this.everywhere(mark, back));
      let farthest = -1;
      for (let n = 0; n < count; n++) {
        const d = Math.min(nearest[n] ?? 0, out[n] ?? 0);
        nearest[n] = d;
        if (Number.isFinite(d) && (farthest < 0 || d > (nearest[farthest] ?? 0))) farthest = n;
      }
      if (farthest < 0) break;
      mark = farthest;
    }
  }

  // Plain Dijkstra over every edge from one node.
  private everywhere(source: number, edges: { first: Int32Array; next: Int32Array; cost: Uint16Array }) {
    const count = this.data.x.length;
    const far = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
    const heap: number[] = [];
    const push = (d: number, id: number) => {
      heap.push(d * 4_194_304 + id);
      let at = heap.length - 1;
      while (at > 0) {
        const up = (at - 1) >> 1;
        if ((heap[up] ?? 0) <= (heap[at] ?? 0)) break;
        [heap[up], heap[at]] = [heap[at] ?? 0, heap[up] ?? 0];
        at = up;
      }
    };
    const pop = () => {
      const top = heap[0] ?? 0;
      const last = heap.pop() ?? 0;
      if (heap.length) {
        heap[0] = last;
        let at = 0;
        for (;;) {
          const left = 2 * at + 1;
          if (left >= heap.length) break;
          const child = left + 1 < heap.length && (heap[left + 1] ?? 0) < (heap[left] ?? 0) ? left + 1 : left;
          if ((heap[child] ?? 0) >= (heap[at] ?? 0)) break;
          [heap[child], heap[at]] = [heap[at] ?? 0, heap[child] ?? 0];
          at = child;
        }
      }
      return top;
    };
    far[source] = 0;
    push(0, source);
    while (heap.length) {
      const value = pop();
      const id = value % 4_194_304;
      const d = Math.floor(value / 4_194_304);
      if (d > (far[id] ?? 0)) continue;
      for (let e = edges.first[id] ?? 0; e < (edges.first[id + 1] ?? 0); e++) {
        const other = edges.next[e] ?? 0;
        const next = d + (edges.cost[e] ?? 0);
        if (next < (far[other] ?? Number.POSITIVE_INFINITY)) {
          far[other] = next;
          push(next, other);
        }
      }
    }
    return far;
  }

  get size() {
    return this.data.x.length;
  }

  private spot(id: number): Spot {
    return { x: this.data.x[id] ?? 0, y: this.data.y[id] ?? 0, z: this.data.z[id] ?? 0 };
  }

  private cellOf(x: number, y: number) {
    return Math.floor(x / CELL) * 1024 + Math.floor(y / CELL);
  }

  // The nodes of its own cell a spot walks to without leaving the cell, with the steps to each; and
  // every spot of the cell it reaches.
  private reach(spot: Spot) {
    if (this.known.size > 400_000) this.known.clear();
    const far = walkInCell(this.terrain, spot, this.closed, this.known);
    const nodes = new Map<number, number>();
    for (const [key, id] of this.byCell.get(this.cellOf(spot.x, spot.y)) ?? []) {
      const away = far.get(key);
      if (away !== undefined && this.data.kind[id] !== 1) nodes.set(id, away);
    }
    return { far, nodes };
  }

  // The piece of land a spot stands on (`land`), by the nearest node it walks to in its cell.
  landAt(spot: Spot) {
    let best: number | undefined;
    let away = Number.POSITIVE_INFINITY;
    for (const [id, steps] of this.reach(spot).nodes)
      if (steps < away) {
        away = steps;
        best = id;
      }
    // A room no crossing of its cell is walked to from: the nearest node about it, near its height.
    return best === undefined ? this.landNear(spot) : this.land[best];
  }

  // The piece of land of the nearest node about a spot, near its height, without walking to it: for
  // placing many spots at once (spawners), where a lookup must stay cheap.
  landNear(spot: Spot) {
    let best: number | undefined;
    let away = Number.POSITIVE_INFINITY;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const id of this.byCell.get(this.cellOf(spot.x + dx * CELL, spot.y + dy * CELL))?.values() ?? []) {
          if (Math.abs((this.data.z[id] ?? 0) - spot.z) > 10) continue;
          const d = chebyshev(spot.x, spot.y, this.data.x[id] ?? 0, this.data.y[id] ?? 0);
          if (d < away) {
            away = d;
            best = id;
          }
        }
    return best === undefined ? undefined : this.land[best];
  }

  // A* from a spot's nodes to another's, or (with no goal) Dijkstra to every node. Gates the
  // `gateOpen` test refuses are not taken.
  private search(
    sources: Map<number, number>,
    goal?: { spot: Spot; nodes: Map<number, number> },
    gateOpen: (name: string) => boolean = () => true,
    seed = 0
  ) {
    const vary = (e: number) => (seed ? 1 + (((Math.imul(e, 2654435761) ^ seed) >>> 0) % 1024) / 4096 : 1);
    const { distance, parent, heap, rank, position } = this;
    distance.fill(Number.POSITIVE_INFINITY);
    parent.fill(-1);
    position.fill(-1);
    // The least a teleporter or gate could leave to walk from where it puts you: an estimate never
    // over the steps left, with them or without.
    let jump = Number.POSITIVE_INFINITY;
    if (goal)
      for (const id of this.portals)
        for (let e = this.first[id] ?? 0; e < (this.first[id + 1] ?? 0); e++) {
          const out = this.next[e] ?? 0;
          const d =
            (this.cost[e] ?? 0) + chebyshev(this.data.x[out] ?? 0, this.data.y[out] ?? 0, goal.spot.x, goal.spot.y);
          if (d < jump) jump = d;
        }
    // Per landmark, the least steps from it to any goal node and the most from any goal node to it.
    const marks = goal
      ? this.fromMark.map((fromMark, i) => {
          let least = Number.POSITIVE_INFINITY;
          let most = Number.NEGATIVE_INFINITY;
          for (const g of goal.nodes.keys()) {
            least = Math.min(least, fromMark[g] ?? Number.POSITIVE_INFINITY);
            most = Math.max(most, this.toMark[i]?.[g] ?? Number.POSITIVE_INFINITY);
          }
          return { fromMark, toMark: this.toMark[i] as Float32Array, least, most };
        })
      : [];
    const estimate = (id: number) => {
      if (!goal) return 0;
      const x = this.data.x[id] ?? 0;
      const y = this.data.y[id] ?? 0;
      let bound = Math.min(chebyshev(x, y, goal.spot.x, goal.spot.y), (this.nearPortal[id] ?? 0) + jump);
      for (const m of marks) {
        const ahead = m.least - (m.fromMark[id] ?? 0);
        const behind = (m.toMark[id] ?? 0) - m.most;
        if (ahead > bound) bound = ahead;
        if (behind > bound) bound = behind;
      }
      return bound;
    };
    let size = 0;
    const up = (id: number) => {
      let at = position[id] ?? -1;
      if (at < 0) at = size++;
      const r = rank[id] ?? 0;
      while (at > 0) {
        const above = (at - 1) >> 1;
        const other = heap[above] ?? 0;
        if ((rank[other] ?? 0) <= r) break;
        heap[at] = other;
        position[other] = at;
        at = above;
      }
      heap[at] = id;
      position[id] = at;
    };
    const pop = () => {
      const top = heap[0] ?? 0;
      const last = heap[--size] ?? 0;
      position[top] = -2;
      if (size) {
        let at = 0;
        const r = rank[last] ?? 0;
        for (;;) {
          const left = 2 * at + 1;
          if (left >= size) break;
          const right = left + 1;
          const child = right < size && (rank[heap[right] ?? 0] ?? 0) < (rank[heap[left] ?? 0] ?? 0) ? right : left;
          const other = heap[child] ?? 0;
          if ((rank[other] ?? 0) >= r) break;
          heap[at] = other;
          position[other] = at;
          at = child;
        }
        heap[at] = last;
        position[last] = at;
      }
      return top;
    };
    for (const [id, away] of sources) {
      distance[id] = away;
      rank[id] = away + estimate(id);
      up(id);
    }
    let best = Number.POSITIVE_INFINITY;
    let end = -1;
    while (size) {
      const id = heap[0] ?? 0;
      if ((rank[id] ?? 0) >= best) break;
      pop();
      const here = distance[id] ?? 0;
      const finish = goal?.nodes.get(id);
      if (finish !== undefined && here + finish < best) {
        best = here + finish;
        end = id;
      }
      const gate = this.gateName.has(id);
      for (let e = this.first[id] ?? 0; e < (this.first[id + 1] ?? 0); e++) {
        const other = this.next[e] ?? 0;
        if ((position[other] ?? -1) === -2) continue;
        const name = this.gateName.get(other);
        if (gate && name !== undefined && !gateOpen(name)) continue;
        const d = here + (this.cost[e] ?? 0) * vary(e);
        if (d < (distance[other] ?? Number.POSITIVE_INFINITY)) {
          distance[other] = d;
          parent[other] = id;
          rank[other] = d + estimate(other);
          up(other);
        }
      }
    }
    return { best, end };
  }

  private edgeCost(a: number, b: number) {
    let least = Number.POSITIVE_INFINITY;
    for (let e = this.first[a] ?? 0; e < (this.first[a + 1] ?? 0); e++)
      if (this.next[e] === b) least = Math.min(least, this.cost[e] ?? 0);
    return least;
  }

  // The fewest steps from one spot to another and the legs of that way, or nothing where no way
  // joins them.
  route(from: Spot, to: Spot, gateOpen?: (name: string) => boolean, seed = 0): Route | undefined {
    const start = this.reach(from);
    const end = this.reach(to);
    const groups = new Set([...end.nodes.keys()].map((id) => this.group[id]));
    const joined = [...start.nodes.keys()].some((id) => groups.has(this.group[id]));
    const inCell = start.far.get(spotKey(to));
    if (!joined && inCell === undefined) return undefined;
    // Steps are taken both ways alike, so the steps from the goal's nodes back to it are the same.
    const { best, end: last } = this.search(start.nodes, { spot: to, nodes: end.nodes }, gateOpen, seed);
    const inside = start.far.get(spotKey(to));
    if (inside !== undefined && inside <= best) return { steps: inside, legs: [{ kind: 'walk', ...to }] };
    // No way on the graph is no way at all: it holds every crossing.
    if (!Number.isFinite(best)) return undefined;
    const nodes: number[] = [];
    for (let at = last; at >= 0; at = this.parent[at] ?? -1) nodes.unshift(at);
    const legs: Leg[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i] ?? 0;
      const kind = this.data.kind[id];
      const following = this.gateName.get(nodes[i + 1] ?? -1);
      if (kind === 1) legs.push({ kind: 'teleport', ...this.spot(id) });
      else if (kind === 2 && following !== undefined) legs.push({ kind: 'gate', ...this.spot(id), to: following });
      else if (!(kind === 2 && this.gateName.has(nodes[i - 1] ?? -1))) legs.push({ kind: 'walk', ...this.spot(id) });
    }
    legs.push({ kind: 'walk', ...to });
    // The steps of the way taken, without the variation that chose it.
    let total = (start.nodes.get(nodes[0] ?? -1) ?? 0) + (end.nodes.get(last) ?? 0);
    for (let i = 1; i < nodes.length; i++) total += this.edgeCost(nodes[i - 1] ?? 0, nodes[i] ?? 0);
    return { steps: total, legs };
  }

  // The fewest steps from a spot to every node (Infinity where no way joins), for weighing many
  // places at once; `toSpot` turns it into the steps to any spot.
  from(spot: Spot, gateOpen?: (name: string) => boolean) {
    const start = this.reach(spot);
    this.search(start.nodes, undefined, gateOpen);
    const reached = Float64Array.from(this.distance);
    return (to: Spot) => {
      const inside = start.far.get(spotKey(to));
      let best = inside ?? Number.POSITIVE_INFINITY;
      for (const [id, away] of this.reach(to).nodes) best = Math.min(best, (reached[id] ?? Infinity) + away);
      return best;
    };
  }
}
