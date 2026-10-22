import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { PathPool } from './path-pool';
import { RouteSearch } from './path-search';

function nameHash(name: string): bigint {
  const data = Buffer.from(name);
  let a = (data.length + 0xdeadbeef) >>> 0;
  let b = a;
  let c = a;
  const rot = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  let offset = 0;
  while (data.length - offset > 12) {
    a = (a + data.readUInt32LE(offset)) >>> 0;
    b = (b + data.readUInt32LE(offset + 4)) >>> 0;
    c = (c + data.readUInt32LE(offset + 8)) >>> 0;
    a = ((a - c) ^ rot(c, 4)) >>> 0;
    c = (c + b) >>> 0;
    b = ((b - a) ^ rot(a, 6)) >>> 0;
    a = (a + c) >>> 0;
    c = ((c - b) ^ rot(b, 8)) >>> 0;
    b = (b + a) >>> 0;
    a = ((a - c) ^ rot(c, 16)) >>> 0;
    c = (c + b) >>> 0;
    b = ((b - a) ^ rot(a, 19)) >>> 0;
    a = (a + c) >>> 0;
    c = ((c - b) ^ rot(b, 4)) >>> 0;
    b = (b + a) >>> 0;
    offset += 12;
  }
  for (let i = 0; offset + i < data.length; i++) {
    const value = (data[offset + i] ?? 0) << ((i % 4) * 8);
    if (i < 4) a = (a + value) >>> 0;
    else if (i < 8) b = (b + value) >>> 0;
    else c = (c + value) >>> 0;
  }
  c = ((c ^ b) - rot(b, 14)) >>> 0;
  a = ((a ^ c) - rot(c, 11)) >>> 0;
  b = ((b ^ a) - rot(a, 25)) >>> 0;
  c = ((c ^ b) - rot(b, 16)) >>> 0;
  a = ((a ^ c) - rot(c, 4)) >>> 0;
  b = ((b ^ a) - rot(a, 14)) >>> 0;
  c = ((c ^ b) - rot(b, 24)) >>> 0;
  return (BigInt(b) << 32n) | BigInt(c);
}

interface Tile {
  flags: number;
  height: number;
  // Item tiledata quality byte: the equipment layer for wearable items.
  layer: number;
  name: string;
}
export interface Point {
  x: number;
  y: number;
  z: number;
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

export interface TerrainBuffers {
  map: SharedArrayBuffer;
  index: SharedArrayBuffer;
  statics: SharedArrayBuffer;
  tiles: SharedArrayBuffer;
}
export class Terrain {
  private readonly tileCache = new Map<number, Tile>();
  private localSearch?: RouteSearch;
  private shared?: TerrainBuffers;
  private readonly cacheKeys = new Uint32Array(32768);
  private cacheCursor = 0;
  private map: Buffer;
  private index: Buffer;
  private statics: Buffer;
  private tiles: Buffer;
  private readonly cache = new Map<number, { land: Point & { id: number }; statics: (Point & { id: number })[] }>();

  // The client map files are about 118 MB per facet and read-only once loaded, so every resident
  // in one process shares a single instance per asset directory and facet.
  private static readonly instances = new Map<string, Terrain>();
  static shared(directory: string, facet = 1, buffers?: TerrainBuffers): Terrain {
    const key = `${directory}:${facet}`;
    let terrain = Terrain.instances.get(key);
    if (!terrain) {
      terrain = new Terrain(directory, facet, buffers);
      Terrain.instances.set(key, terrain);
    }
    return terrain;
  }

  constructor(
    readonly directory: string,
    readonly facet = 1,
    buffers?: TerrainBuffers
  ) {
    if (buffers) {
      this.map = Buffer.from(buffers.map);
      this.index = Buffer.from(buffers.index);
      this.statics = Buffer.from(buffers.statics);
      this.tiles = Buffer.from(buffers.tiles);
      this.shared = buffers;
      return;
    }
    this.tiles = readFileSync(join(directory, 'tiledata.mul'));
    if (this.tiles.length !== 3188736) throw new Error('Terrain requires the modern 64-bit tiledata format');
    this.index = readFileSync(join(directory, `staidx${facet}.mul`));
    this.statics = readFileSync(join(directory, `statics${facet}.mul`));
    const uop = readFileSync(join(directory, `map${facet}LegacyMUL.uop`));
    if (uop.readUInt32LE(0) !== 0x0050594d) throw new Error('Invalid map UOP');
    const entries = new Map<bigint, Buffer>();
    const visited = new Set<number>();
    for (let block = Number(uop.readBigUInt64LE(12)); block !== 0; ) {
      if (visited.has(block)) throw new Error('Cyclic map UOP');
      visited.add(block);
      const count = uop.readUInt32LE(block);
      const next = Number(uop.readBigUInt64LE(block + 4));
      for (let i = 0; i < count; i++) {
        const at = block + 12 + i * 34;
        const offset = Number(uop.readBigUInt64LE(at));
        if (!offset) continue;
        const start = offset + uop.readUInt32LE(at + 8);
        const length = uop.readUInt32LE(at + 12);
        const bytes = uop.subarray(start, start + length);
        const value = uop.readUInt16LE(at + 32) === 1 ? inflateSync(bytes) : bytes;
        if (value.length !== uop.readUInt32LE(at + 16)) throw new Error('Truncated map chunk');
        entries.set(uop.readBigUInt64LE(at + 20), value);
      }
      block = next;
    }
    const chunks: Buffer[] = [];
    const expected = ((7168 * 4096) / 64) * 196;
    for (let i = 0; chunks.reduce((sum, chunk) => sum + chunk.length, 0) < expected; i++) {
      const chunk = entries.get(nameHash(`build/map${facet}legacymul/${String(i).padStart(8, '0')}.dat`));
      if (!chunk) throw new Error(`Missing map chunk ${i}`);
      chunks.push(chunk);
    }
    this.map = Buffer.concat(chunks);
    if (this.map.length !== expected) throw new Error('Unexpected map dimensions');
  }

  sharedBuffers(): TerrainBuffers {
    if (!this.shared) {
      const copy = (bytes: Buffer) => {
        const memory = new SharedArrayBuffer(bytes.length);
        new Uint8Array(memory).set(bytes);
        return memory;
      };
      this.shared = {
        map: copy(this.map),
        index: copy(this.index),
        statics: copy(this.statics),
        tiles: copy(this.tiles)
      };
      this.map = Buffer.from(this.shared.map);
      this.index = Buffer.from(this.shared.index);
      this.statics = Buffer.from(this.shared.statics);
      this.tiles = Buffer.from(this.shared.tiles);
    }
    return this.shared;
  }

  tile(id: number, item = false): Tile {
    const key = id + (item ? 0x10000 : 0);
    const cached = this.tileCache.get(key);
    if (cached) return cached;
    const base = item ? 493568 : 0;
    const size = item ? 41 : 30;
    const offset = base + (id >> 5) * (4 + 32 * size) + 4 + (id & 31) * size;
    const value = {
      flags: this.tiles.readUInt32LE(offset),
      height: item ? this.tiles.readUInt8(offset + 20) : 0,
      layer: item ? this.tiles.readUInt8(offset + 9) : 0,
      name:
        this.tiles
          .subarray(offset + (item ? 21 : 10), offset + size)
          .toString('latin1')
          .split('\0')[0] ?? ''
    };
    this.tileCache.set(key, value);
    return value;
  }

  findStatics(ids: ReadonlySet<number>, origin: Point, radius: number): (Point & { id: number })[] {
    const matches: (Point & { id: number })[] = [];
    const minX = Math.max(0, (origin.x - radius) >> 3);
    const maxX = Math.min(895, (origin.x + radius) >> 3);
    const minY = Math.max(0, (origin.y - radius) >> 3);
    const maxY = Math.min(511, (origin.y + radius) >> 3);
    for (let bx = minX; bx <= maxX; bx++)
      for (let by = minY; by <= maxY; by++) {
        const block = bx * 512 + by;
        const start = this.index.readInt32LE(block * 12);
        const length = this.index.readInt32LE(block * 12 + 4);
        if (start < 0 || length <= 0) continue;
        for (let offset = start; offset < start + length; offset += 7) {
          const id = this.statics.readUInt16LE(offset);
          if (!ids.has(id)) continue;
          const x = bx * 8 + this.statics.readUInt8(offset + 2);
          const y = by * 8 + this.statics.readUInt8(offset + 3);
          if (Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y)) <= radius)
            matches.push({ id, x, y, z: this.statics.readInt8(offset + 4) });
        }
      }
    return matches.sort(
      (a, b) =>
        Math.max(Math.abs(a.x - origin.x), Math.abs(a.y - origin.y)) -
        Math.max(Math.abs(b.x - origin.x), Math.abs(b.y - origin.y))
    );
  }

  cell(x: number, y: number) {
    if (x < 0 || x >= 7167 || y < 0 || y >= 4095) throw new Error('Terrain coordinate outside supported facet');
    const key = x * 4096 + y;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const block = (x >> 3) * 512 + (y >> 3);
    const at = block * 196 + 4 + ((y & 7) * 8 + (x & 7)) * 3;
    const land = { x, y, id: this.map.readUInt16LE(at) & 0x3fff, z: this.map.readInt8(at + 2) };
    const statics: (Point & { id: number })[] = [];
    const offset = this.index.readInt32LE(block * 12);
    const length = this.index.readInt32LE(block * 12 + 4);
    if (offset >= 0 && length > 0)
      for (let i = offset; i < offset + length; i += 7) {
        if (this.statics[i + 2] === (x & 7) && this.statics[i + 3] === (y & 7))
          statics.push({ x, y, id: this.statics.readUInt16LE(i), z: this.statics.readInt8(i + 4) });
      }
    const value = { land, statics };
    const slot = this.cacheCursor++ & 32767;
    if (this.cache.size >= 32768) this.cache.delete(this.cacheKeys[slot]!);
    this.cacheKeys[slot] = key;
    this.cache.set(key, value);
    return value;
  }

  stand(x: number, y: number, fromZ: number, from?: Point): Point | null {
    const z = this.standingZ(x, y, fromZ, from);
    return z === undefined ? null : { x, y, z };
  }

  standingZ(x: number, y: number, fromZ: number, from?: Point): number | undefined {
    const cell = this.cell(x, y);
    const a = cell.land.z,
      b = this.cell(x + 1, y).land.z,
      c = this.cell(x, y + 1).land.z,
      d = this.cell(x + 1, y + 1).land.z;
    const landZ = Math.floor(Math.abs(a - d) > Math.abs(b - c) ? (b + c) / 2 : (a + d) / 2);
    let startTop = fromZ;
    if (from) {
      const a = this.cell(from.x, from.y).land.z,
        b = this.cell(from.x + 1, from.y).land.z;
      const c = this.cell(from.x, from.y + 1).land.z,
        d = this.cell(from.x + 1, from.y + 1).land.z;
      const average = Math.floor(Math.abs(a - d) > Math.abs(b - c) ? (b + c) / 2 : (a + d) / 2);
      if (fromZ >= average && !(this.tile(this.cell(from.x, from.y).land.id).flags & 0xc0))
        startTop = Math.max(fromZ, a, b, c, d);
      for (const item of this.cell(from.x, from.y).statics) {
        const tile = this.tile(item.id, true);
        const top = item.z + (tile.flags & 0x400 ? Math.floor(tile.height / 2) : tile.height);
        if (tile.flags & 0x200 && top <= fromZ) startTop = Math.max(startTop, item.z + tile.height);
      }
    }
    let best: number | undefined;
    let delta = Infinity;
    const landAllowed = !(this.tile(cell.land.id).flags & 0xc0);
    for (let index = landAllowed ? -1 : 0; index < cell.statics.length; index++) {
      let z: number;
      let stepTop: number;
      if (index < 0) {
        z = landZ;
        stepTop = Math.min(a, b, c, d);
      } else {
        const item = cell.statics[index]!;
        const tile = this.tile(item.id, true);
        if ((tile.flags & 0x240) !== 0x200) continue;
        z = item.z + (tile.flags & 0x400 ? Math.floor(tile.height / 2) : tile.height);
        stepTop = item.z + (tile.flags & 0x400 ? 0 : tile.height);
      }
      if (stepTop > startTop + 2 || z < fromZ - 16 || Math.abs(z - fromZ) >= delta) continue;
      let clear = true;
      for (const item of cell.statics) {
        const tile = this.tile(item.id, true);
        const height = tile.flags & 0x400 ? Math.floor(tile.height / 2) : tile.height;
        if (tile.flags & 0x240 && item.z < z + 16 && item.z + height > z) {
          clear = false;
          break;
        }
      }
      if (clear) {
        best = z;
        delta = Math.abs(z - fromZ);
      }
    }
    return best;
  }

  path(
    start: Point,
    goal: { x: number; y: number },
    range = 0,
    blocked = new Set<string>(),
    targetZ?: number
  ): Point[] | null {
    this.localSearch ??= new RouteSearch();
    return this.localSearch.run(this, { start, goal, range, blocked: [...blocked], targetZ }).path;
  }

  async pathAsync(
    start: Point,
    goal: { x: number; y: number },
    range = 0,
    blocked = new Set<string>(),
    targetZ?: number,
    signal?: AbortSignal,
    partial = false
  ): Promise<Point[] | null> {
    const result = await PathPool.get(this.directory, this.facet, this.sharedBuffers()).run(
      { start, goal, range, blocked: [...blocked], targetZ, partial },
      signal
    );
    return result.path;
  }
}

export function directionTo(from: Point, to: Point): number {
  return directions.findIndex(([x, y]) => x === Math.sign(to.x - from.x) && y === Math.sign(to.y - from.y));
}
