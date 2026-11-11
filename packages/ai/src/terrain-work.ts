import type { Point, WorkTile } from './terrain';

const bucketSize = 64;

type Tiles = { land: number[]; statics: number[] };
type Node = { x: number; y: number; size: number; children?: Node[]; points?: Float64Array };
type Blocks = Map<number, Node>;
const unpack = (packed: number, graphic: number): WorkTile => ({
  x: packed % 8192,
  y: Math.floor(packed / 8192) % 4096,
  z: Math.floor(packed / 33554432) - 128,
  ...(graphic >= 65536 ? { id: graphic - 65536 } : { land: graphic })
});
const kind = (graphic: number) => (graphic >= 65536 ? { id: graphic - 65536 } : { land: graphic });

export class WorkIndex {
  private readonly cached = new Map<string, Blocks>();

  constructor(
    private readonly map: Buffer,
    private readonly index: Buffer,
    private readonly statics: Buffer
  ) {}

  private blocks(tiles: Tiles) {
    const key = JSON.stringify(tiles);
    const known = this.cached.get(key);
    if (known) return known;
    const found = new Map<number, Map<number, number[]>>();
    const add = (graphic: number, x: number, y: number, z: number) => {
      const block = Math.floor(x / bucketSize) * (4096 / bucketSize) + Math.floor(y / bucketSize);
      let blocks = found.get(graphic);
      if (!blocks) {
        blocks = new Map();
        found.set(graphic, blocks);
      }
      let points = blocks.get(block);
      if (!points) {
        points = [];
        blocks.set(block, points);
      }
      points.push(x + y * 8192 + (z + 128) * 33554432);
    };
    const land = new Set(tiles.land);
    const statics = new Set(tiles.statics);
    for (let block = 0; block < this.map.length / 196; block++) {
      const bx = Math.floor(block / 512) * 8;
      const by = (block % 512) * 8;
      if (land.size)
        for (let cell = 0; cell < 64; cell++) {
          const offset = block * 196 + 4 + cell * 3;
          const id = this.map.readUInt16LE(offset);
          if (land.has(id)) add(id, bx + (cell % 8), by + Math.floor(cell / 8), this.map.readInt8(offset + 2));
        }
      if (!statics.size || block * 12 + 8 > this.index.length) continue;
      const start = this.index.readInt32LE(block * 12);
      const length = this.index.readInt32LE(block * 12 + 4);
      if (start < 0 || length <= 0) continue;
      for (let offset = start; offset < start + length; offset += 7) {
        const id = this.statics.readUInt16LE(offset);
        if (statics.has(id))
          add(
            id + 65536,
            bx + this.statics.readUInt8(offset + 2),
            by + this.statics.readUInt8(offset + 3),
            this.statics.readInt8(offset + 4)
          );
      }
    }
    const packed: Blocks = new Map();
    const width = Math.ceil(this.map.length / 196 / 512);
    const size = 2 ** Math.ceil(Math.log2(Math.max(width, 512))) * 8;
    for (const [graphic, blocks] of found) {
      const root: Node = { x: 0, y: 0, size };
      for (const [block, points] of blocks) {
        const x = Math.floor(block / (4096 / bucketSize)) * bucketSize;
        const y = (block % (4096 / bucketSize)) * bucketSize;
        let node = root;
        while (node.size > bucketSize) {
          const half = node.size / 2;
          const nx = node.x + (x >= node.x + half ? half : 0);
          const ny = node.y + (y >= node.y + half ? half : 0);
          node.children ??= [];
          let child = node.children.find((c) => c.x === nx && c.y === ny);
          if (!child) {
            child = { x: nx, y: ny, size: half };
            node.children.push(child);
          }
          node = child;
        }
        node.points = new Float64Array(points);
      }
      packed.set(graphic, root);
    }
    this.cached.set(key, packed);
    return packed;
  }

  *find(tiles: Tiles): Generator<WorkTile> {
    function* points(node: Node): Generator<number> {
      if (node.points) yield* node.points;
      for (const child of node.children ?? []) yield* points(child);
    }
    for (const [graphic, root] of this.blocks(tiles)) for (const point of points(root)) yield unpack(point, graphic);
  }

  // Only provably dominated destinations are skipped. The upper bound ignores local failures;
  // no distance or candidate-count cutoff changes which destination can win.
  best(
    tiles: Tiles,
    origin: Point,
    score: (point: WorkTile) => number,
    upper: (kind: Pick<WorkTile, 'id' | 'land'>, distance: number) => number
  ): WorkTile[] {
    const found: WorkTile[] = [];
    for (const [graphic, root] of this.blocks(tiles)) {
      const distance = (node: Node) =>
        Math.max(
          0,
          node.x - origin.x,
          origin.x - node.x - node.size + 1,
          node.y - origin.y,
          origin.y - node.y - node.size + 1
        );
      let best: WorkTile | undefined;
      let rate = Number.NEGATIVE_INFINITY;
      const visit = (node: Node) => {
        if (best && upper(kind(graphic), distance(node)) <= rate) return;
        for (const packed of node.points ?? []) {
          const point = unpack(packed, graphic);
          const value = score(point);
          if (value > rate) {
            rate = value;
            best = point;
          }
        }
        for (const child of [...(node.children ?? [])].sort((a, b) => distance(a) - distance(b))) visit(child);
      };
      visit(root);
      if (best) found.push(best);
    }
    return found;
  }
}
