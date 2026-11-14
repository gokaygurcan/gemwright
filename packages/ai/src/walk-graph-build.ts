import type { Link } from './links';

// How the land joins up on foot, from the client's own map, as crossings: Trammel cut into 32-tile
// cells, and wherever a straight step crosses a cell's edge, a pair of nodes on the two sides (one
// pair every few tiles along an open edge, so a way never bends to reach one). Inside a cell, every
// node is joined to every other it reaches without leaving the cell, at the exact number of steps
// (a breadth-first walk). Teleporters join their entrance tile to where they put you; public
// moongates join each other. Steps follow the shard's rules as the route search does (path-search.ts):
// at most 8 up or down, a diagonal only past two standable sides, a teleporter's tile never walked
// over.
export const CELL = 32;
// Bounds the packing of edges into one number: node ids under 4,194,304, costs under 2,048 steps.
const NODES = 4_194_304;
const COSTS = 2048;
const MAX_STEP_Z = 8;
export const directions = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
] as const;

export interface WalkGraphData {
  // Nodes; `kind` 0 is a crossing or an arrival, 1 a teleporter's entrance tile, 2 a moongate.
  x: Uint16Array;
  y: Uint16Array;
  z: Int8Array;
  kind: Uint8Array;
  // Directed edges, cost in steps (a moongate's jump in its own cost).
  from: Int32Array;
  to: Int32Array;
  cost: Uint16Array;
  // The gates' nodes by their name in the gate menu.
  gates: Record<string, number>;
}

export interface Ground {
  cell(x: number, y: number): { land: { z: number }; statics: { id: number; z: number }[] };
  tile(id: number, item?: boolean): { height: number };
  standingZ(x: number, y: number, fromZ: number, from?: { x: number; y: number; z: number }): number | undefined;
}
export type Spot = { x: number; y: number; z: number };

// The height a step from `from` onto (x, y) lands at, or nothing where the shard refuses it.
export function stepTo(terrain: Ground, from: Spot, x: number, y: number) {
  if (x < 1 || y < 1 || x > 7165 || y > 4093) return undefined;
  const z = terrain.standingZ(x, y, from.z, { ...from });
  if (z === undefined || Math.abs(z - from.z) > MAX_STEP_Z) return undefined;
  if (x !== from.x && y !== from.y) {
    const side = (sx: number, sy: number) => terrain.standingZ(sx, sy, from.z, { ...from }) !== undefined;
    if (!side(x, from.y) || !side(from.x, y)) return undefined;
  }
  return z;
}

// Every spot one step from `at`, with teleporter tiles (`x * 4096 + y`) never walked over: the same
// steps as `stepTo`, each neighbour's height looked up once (a diagonal's two sides are the straight
// steps beside it).
export function steps(terrain: Ground, at: Spot, closed: ReadonlySet<number>): Spot[] {
  const heights: (number | undefined)[] = [];
  for (const [dx, dy] of directions) {
    const x = at.x + dx;
    const y = at.y + dy;
    heights.push(x < 1 || y < 1 || x > 7165 || y > 4093 ? undefined : terrain.standingZ(x, y, at.z, at));
  }
  const found: Spot[] = [];
  directions.forEach(([dx, dy], i) => {
    const x = at.x + dx;
    const y = at.y + dy;
    const z = heights[i];
    if (z === undefined || Math.abs(z - at.z) > MAX_STEP_Z || closed.has(x * 4096 + y)) return;
    if (dx && dy) {
      if (closed.has(x * 4096 + at.y) || closed.has(at.x * 4096 + y)) return;
      // The straight steps beside a diagonal: east or west is `i + 1` or `i - 1` round the circle.
      if (heights[(i + 1) % 8] === undefined || heights[(i + 7) % 8] === undefined) return;
    }
    found.push({ x, y, z });
  });
  return found;
}

export const spotKey = (p: Spot) => (p.x * 4096 + p.y) * 512 + p.z + 256;
const spotOf = (key: number): Spot => ({
  x: Math.floor(key / 2_097_152),
  y: Math.floor(key / 512) % 4096,
  z: (key % 512) - 256
});

// Breadth-first steps from `source` without leaving its cell: every spot it reaches and how far.
// `known` keeps each spot's steps for further walks in the same cell, as their keys: one array of
// numbers a spot, not an object a step, as it is kept for many thousands of spots.
export function walkInCell(
  terrain: Ground,
  source: Spot,
  closed: ReadonlySet<number>,
  known: Map<number, number[]> = new Map()
) {
  const x0 = Math.floor(source.x / CELL) * CELL;
  const y0 = Math.floor(source.y / CELL) * CELL;
  const far = new Map([[spotKey(source), 0]]);
  const queue: Spot[] = [source];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as Spot;
    const here = spotKey(at);
    const away = far.get(here) ?? 0;
    let around = known.get(here);
    if (!around) {
      around = steps(terrain, at, closed).map(spotKey);
      known.set(here, around);
    }
    for (const key of around) {
      if (far.has(key)) continue;
      const next = spotOf(key);
      if (next.x < x0 || next.x >= x0 + CELL || next.y < y0 || next.y >= y0 + CELL) continue;
      far.set(key, away + 1);
      queue.push(next);
    }
  }
  return far;
}

export async function buildWalkGraph(
  terrain: Ground,
  teleporters: readonly Link[],
  gates: Record<string, { x: number; y: number; z?: number }>,
  // A moongate's jump (stepping on, the menu, the choice) as steps of walking.
  gateCost = 10,
  // The land to cover: the whole facet unless a test asks for less.
  bounds = { x: 0, y: 0, width: 7168, height: 4096 },
  // Crossings along an open edge, every so many tiles (one per stretch at the cell size).
  spacing = 32,
  pause: () => Promise<unknown> = () => Bun.sleep(0)
): Promise<WalkGraphData> {
  const data = {
    x: [] as number[],
    y: [] as number[],
    z: [] as number[],
    kind: [] as number[],
    gates: {} as Record<string, number>
  };
  const closed = new Set(teleporters.map((l) => l.from.x * 4096 + l.from.y));
  const ids = new Map<number, number>();
  const byCell = new Map<number, number[]>();
  const cellOf = (x: number, y: number) => Math.floor(x / CELL) * 1024 + Math.floor(y / CELL);
  const node = (p: Spot, kind: number) => {
    const key = spotKey(p);
    const known = ids.get(key);
    if (known !== undefined) {
      if (kind) data.kind[known] = kind;
      return known;
    }
    const id = data.x.length;
    data.x.push(p.x);
    data.y.push(p.y);
    data.z.push(p.z);
    data.kind.push(kind);
    ids.set(key, id);
    const cell = cellOf(p.x, p.y);
    byCell.set(cell, [...(byCell.get(cell) ?? []), id]);
    return id;
  };
  // Edges packed as one number each (from, to, cost) in a buffer that grows; sorted at the end,
  // which leaves each pair's cheapest first.
  let packed = new Float64Array(1 << 20);
  let count = 0;
  const edge = (a: number, b: number, cost: number) => {
    if (a === b) return;
    if (count === packed.length) {
      const grown = new Float64Array(packed.length * 2);
      grown.set(packed);
      packed = grown;
    }
    packed[count++] = (a * NODES + b) * COSTS + Math.min(cost, COSTS - 1);
  };
  // Every height one can stand at on a tile: on the land, and on top of anything built there (a
  // floor over water, a bridge, an upper storey).
  const levels = (x: number, y: number): Spot[] => {
    if (x < 1 || y < 1 || x > 7165 || y > 4093) return [];
    const cell = terrain.cell(x, y);
    const found = new Map<number, Spot>();
    for (const from of [cell.land.z, ...cell.statics.map((s) => s.z + terrain.tile(s.id, true).height)]) {
      const z = terrain.standingZ(x, y, from);
      if (z !== undefined) found.set(z, { x, y, z });
    }
    return [...found.values()];
  };
  // The standable height on a tile nearest one a list gives (the rules may list one nobody can stand
  // at: Magincia's gate at 0, stood on at 31).
  const nearest = (p: { x: number; y: number; z?: number }) =>
    levels(p.x, p.y).sort((a, b) => Math.abs(a.z - (p.z ?? a.z)) - Math.abs(b.z - (p.z ?? b.z)))[0];
  const inBounds = (x: number, y: number) =>
    x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;

  // Teleporters: the entrance tile, and the spot they put you on (or a step off it, when that is
  // another entrance). Gates: their tile, and a jump to every other gate.
  const entrances = new Map<number, number>();
  for (const link of teleporters) {
    if (!inBounds(link.from.x, link.from.y) || !inBounds(link.to.x, link.to.y)) continue;
    const entrance = node({ x: link.from.x, y: link.from.y, z: link.from.z }, 1);
    entrances.set(link.from.x * 4096 + link.from.y, entrance);
    const arrival = nearest(link.to) ?? { ...link.to };
    if (!closed.has(arrival.x * 4096 + arrival.y)) {
      edge(entrance, node(arrival, 0), 1);
      continue;
    }
    // Put onto another entrance (a two-way pair): it walks off it, a step to any side.
    for (const off of steps(terrain, arrival, closed)) edge(entrance, node(off, 0), 2);
  }
  const gateIds: number[] = [];
  for (const [name, gate] of Object.entries(gates)) {
    if (!inBounds(gate.x, gate.y)) continue;
    const spot = nearest(gate);
    if (!spot) continue;
    const id = node(spot, 2);
    data.gates[name] = id;
    gateIds.push(id);
  }
  for (const a of gateIds) for (const b of gateIds) edge(a, b, gateCost);

  // Crossings: along each cell's east and south edges, every step across (straight or diagonal, either
  // way); where they run on, one place every `spacing` tiles (and the middle of a shorter run) keeps
  // all of its steps across as pairs of nodes.
  const moves = (a: Spot | undefined, b: Spot | undefined) => {
    if (!a || !b || closed.has(a.x * 4096 + a.y) || closed.has(b.x * 4096 + b.y)) return [];
    const found: [Spot, Spot][] = [];
    const there = stepTo(terrain, a, b.x, b.y);
    if (there !== undefined) found.push([a, { ...b, z: there }]);
    const back = stepTo(terrain, b, a.x, a.y);
    if (back !== undefined) found.push([b, { ...a, z: back }]);
    return found;
  };
  // Which piece of its cell (spots joined by steps that stay inside it) each spot on a cell's edge
  // belongs to: a stretch of edge that two pieces share needs a crossing for each.
  // Kept for two columns of cells at a time: the one being crossed from and the one to its east.
  const piece = new Map<number, Map<number, number>>();
  let pieces = 0;
  const label = async (x0: number, y0: number) => {
    const column = piece.get(x0 / CELL) ?? new Map<number, number>();
    piece.set(x0 / CELL, column);
    const known = new Map<number, number[]>();
    const seen = new Set<number>();
    for (let y = Math.max(1, y0); y < Math.min(4094, y0 + CELL); y++)
      for (let x = Math.max(1, x0); x < Math.min(7166, x0 + CELL); x++) {
        if (closed.has(x * 4096 + y)) continue;
        for (const spot of levels(x, y)) {
          if (seen.has(spotKey(spot))) continue;
          const id = pieces++;
          for (const key of walkInCell(terrain, spot, closed, known).keys()) {
            seen.add(key);
            const tx = Math.floor(key / 512 / 4096);
            const ty = Math.floor(key / 512) % 4096;
            if (tx === x0 || ty === y0 || tx === x0 + CELL - 1 || ty === y0 + CELL - 1) column.set(key, id);
          }
        }
      }
  };
  // Each direction across on its own, and each pair of pieces it joins on its own: a step one way only
  // (a drop) may lie anywhere along the edge.
  type Place = { x: number; y: number; moves: [Spot, Spot][] };
  const pieceOf = (p: Spot) => piece.get(Math.floor(p.x / CELL))?.get(spotKey(p)) ?? -1 - spotKey(p);
  const runs = (line: Place[]) => {
    for (const outward of [true, false]) {
      const side = line.map((p) =>
        p.moves
          .filter(([from]) => (from.x === p.x && from.y === p.y) === outward)
          .map((move) => ({ move, joins: `${pieceOf(move[0])}>${pieceOf(move[1])}` }))
      );
      for (const joins of new Set(side.flatMap((moves) => moves.map((m) => m.joins)))) {
        let start = -1;
        for (let i = 0; i <= side.length; i++) {
          const open = i < side.length && !!side[i]?.some((m) => m.joins === joins);
          if (open && start < 0) start = i;
          if (!open && start >= 0) {
            const length = i - start;
            const parts = Math.ceil(length / spacing);
            const picks =
              length <= spacing
                ? [start + Math.floor(length / 2)]
                : Array.from({ length: parts + 1 }, (_, k) => start + Math.round((k * (length - 1)) / parts));
            for (const k of new Set(picks))
              for (const { move } of side[k] ?? [])
                if (move && side[k]?.some((m) => m.joins === joins && m.move === move))
                  edge(node(move[0], 0), node(move[1], 0), 1);
            start = -1;
          }
        }
      }
    }
  };
  const x1 = Math.min(7166, bounds.x + bounds.width);
  const y1 = Math.min(4094, bounds.y + bounds.height);
  const labelColumn = async (cx: number) => {
    if (piece.has(cx) || cx * CELL >= x1) return;
    for (let cy = Math.floor(bounds.y / CELL); cy * CELL < y1; cy++) await label(cx * CELL, cy * CELL);
  };
  for (let cx = Math.floor(bounds.x / CELL); cx * CELL < x1; cx++) {
    await labelColumn(cx);
    await labelColumn(cx + 1);
    piece.delete(cx - 1);
    for (let cy = Math.floor(bounds.y / CELL); cy * CELL < y1; cy++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      if (x0 + CELL < x1) {
        const line: Place[] = [];
        for (let y = Math.max(1, y0); y < Math.min(y1, y0 + CELL); y++) {
          const near = levels(x0 + CELL - 1, y);
          line.push({
            x: x0 + CELL - 1,
            y,
            moves: near.flatMap((a) =>
              [0, -1, 1].flatMap((dy) => levels(x0 + CELL, y + dy).flatMap((b) => moves(a, b)))
            )
          });
        }
        runs(line);
      }
      if (y0 + CELL < y1) {
        const line: Place[] = [];
        for (let x = Math.max(1, x0); x < Math.min(x1, x0 + CELL); x++) {
          const near = levels(x, y0 + CELL - 1);
          line.push({
            x,
            y: y0 + CELL - 1,
            moves: near.flatMap((a) =>
              [0, -1, 1].flatMap((dx) => levels(x + dx, y0 + CELL).flatMap((b) => moves(a, b)))
            )
          });
        }
        runs(line);
      }
    }
    if ((cx & 7) === 0) await pause();
  }

  // Inside each cell: from every node one can stand on, a breadth-first walk to the others, and to
  // any teleporter entrance a step beside the way.
  let walked = 0;
  for (const members of byCell.values()) {
    const known = new Map<number, number[]>();
    const keys = new Map(
      members.map((id) => [spotKey({ x: data.x[id] ?? 0, y: data.y[id] ?? 0, z: data.z[id] ?? 0 }), id])
    );
    // The steps between every two nodes of the cell; a pair that some third node lies on the way
    // between (as short through it) needs no edge of its own, and the shortest ways stay the same.
    const within = new Map<number, Map<number, number>>();
    for (const id of members) {
      if (data.kind[id] === 1) continue;
      const source = { x: data.x[id] ?? 0, y: data.y[id] ?? 0, z: data.z[id] ?? 0 };
      const far = walkInCell(terrain, source, closed, known);
      const row = new Map<number, number>();
      for (const [key, other] of keys) {
        const away = far.get(key);
        if (away !== undefined && other !== id && data.kind[other] !== 1) row.set(other, away);
      }
      within.set(id, row);
      if (entrances.size)
        for (const [key, away] of far) {
          const x = Math.floor(key / 512 / 4096);
          const y = Math.floor(key / 512) % 4096;
          const z = (key % 512) - 256;
          for (const [dx, dy] of directions) {
            const entrance = entrances.get((x + dx) * 4096 + y + dy);
            if (entrance !== undefined && stepTo(terrain, { x, y, z }, x + dx, y + dy) !== undefined)
              edge(id, entrance, away + 1);
          }
        }
      if ((++walked & 255) === 0) await pause();
    }
    for (const [i, row] of within)
      for (const [j, d] of row) {
        let through = false;
        for (const [k, dk] of row) {
          if (k === j) continue;
          const kj = within.get(k)?.get(j);
          if (kj !== undefined && dk + kj <= d) {
            through = true;
            break;
          }
        }
        if (!through) edge(i, j, d);
      }
  }
  const sorted = packed.subarray(0, count).sort();
  let kept = 0;
  for (let i = 0; i < sorted.length; i++)
    if (!i || Math.floor((sorted[i] ?? 0) / COSTS) !== Math.floor((sorted[i - 1] ?? 0) / COSTS))
      sorted[kept++] = sorted[i] ?? 0;
  const from = new Int32Array(kept);
  const to = new Int32Array(kept);
  const cost = new Uint16Array(kept);
  for (let i = 0; i < kept; i++) {
    const value = sorted[i] ?? 0;
    const pair = Math.floor(value / COSTS);
    from[i] = Math.floor(pair / NODES);
    to[i] = pair % NODES;
    cost[i] = value % COSTS;
  }
  return {
    x: Uint16Array.from(data.x),
    y: Uint16Array.from(data.y),
    z: Int8Array.from(data.z),
    kind: Uint8Array.from(data.kind),
    from,
    to,
    cost,
    gates: data.gates
  };
}
