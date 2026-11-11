import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Uop } from '@gemwright/common/assets/uop';

export interface Component {
  id: number;
  x: number;
  y: number;
  z: number;
}

export function decodeMultiUop(bytes: Buffer): Component[] {
  if (bytes.length < 8) throw new Error('Truncated multi asset');
  const count = bytes.readUInt32LE(4);
  if (count > 65536) throw new Error('Multi component limit exceeded');
  const result: Component[] = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    if (offset + 14 > bytes.length) throw new Error('Truncated multi component');
    const id = bytes.readUInt16LE(offset);
    const x = bytes.readInt16LE(offset + 2),
      y = bytes.readInt16LE(offset + 4),
      z = bytes.readInt16LE(offset + 6);
    const visible = bytes.readUInt16LE(offset + 8) !== 1;
    const clilocs = bytes.readUInt32LE(offset + 10);
    offset += 14 + clilocs * 4;
    if (offset > bytes.length) throw new Error('Truncated multi component properties');
    if (visible || i === 0) result.push({ id, x, y, z });
  }
  return result;
}

export class MultiAssets {
  private readonly uop?: Uop;
  private readonly index?: Buffer;
  private readonly data?: Buffer;
  private readonly cache = new Map<number, readonly Component[]>();
  constructor(directory: string) {
    const uop = join(directory, 'MultiCollection.uop');
    if (existsSync(uop)) this.uop = new Uop(uop);
    else if (existsSync(join(directory, 'multi.idx')) && existsSync(join(directory, 'multi.mul'))) {
      this.index = readFileSync(join(directory, 'multi.idx'));
      this.data = readFileSync(join(directory, 'multi.mul'));
    }
  }
  components(id: number): readonly Component[] {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let parts: Component[] = [];
    const bytes = this.uop?.read(`build/multicollection/${String(id).padStart(6, '0')}.bin`);
    if (bytes) parts = decodeMultiUop(bytes);
    else if (this.index && this.data && id * 12 + 12 <= this.index.length) {
      const offset = this.index.readInt32LE(id * 12),
        size = this.index.readInt32LE(id * 12 + 4);
      if (offset >= 0 && size > 0) {
        // The supported modern client uses post-High Seas 16-byte multi entries.
        if (size % 16 || offset + size > this.data.length) throw new Error('Invalid modern multi asset');
        for (let at = offset; at < offset + size; at += 16) {
          if (at === offset || this.data.readBigUInt64LE(at + 8) !== 0n)
            parts.push({
              id: this.data.readUInt16LE(at),
              x: this.data.readInt16LE(at + 2),
              y: this.data.readInt16LE(at + 4),
              z: this.data.readInt16LE(at + 6)
            });
        }
      }
    }
    this.cache.set(id, parts);
    return parts;
  }
}

export function expandDesign(
  planes: readonly { id: number; data: Uint8Array }[],
  foundation: readonly Component[]
): Component[] {
  if (!foundation.length) throw new Error('Custom house foundation asset is unavailable');
  const minX = Math.min(0, ...foundation.map((p) => p.x)),
    maxX = Math.max(0, ...foundation.map((p) => p.x));
  const minY = Math.min(0, ...foundation.map((p) => p.y)),
    maxY = Math.max(0, ...foundation.map((p) => p.y));
  // HouseFoundation.GetEmptyFoundation extends the asset by one south stair row.
  const width = maxX - minX + 1,
    height = maxY - minY + 2;
  const parts: Component[] = [];
  for (const plane of planes) {
    const bytes = Buffer.from(plane.data);
    if (plane.id < 0x20) {
      for (let at = 0; at < bytes.length; at += 5)
        parts.push({
          id: bytes.readUInt16BE(at),
          x: bytes.readInt8(at + 2),
          y: bytes.readInt8(at + 3),
          z: bytes.readInt8(at + 4)
        });
      continue;
    }
    const level = plane.id & 15;
    const floor = level > 0 && level < 5;
    const rows = height - (floor ? 2 : level === 0 ? 0 : 1);
    const columns = width - (floor ? 1 : 0);
    if (rows <= 0 || columns <= 0 || bytes.length !== rows * columns * 2)
      throw new Error('House plane does not match its foundation');
    for (let at = 0; at < bytes.length; at += 2) {
      const id = bytes.readUInt16BE(at);
      if (!id) continue;
      parts.push({
        id,
        x: minX + Math.floor(at / 2 / rows) + Number(floor),
        y: minY + ((at / 2) % rows) + Number(floor),
        z: level === 0 ? 0 : 7 + ((level - 1) % 4) * 20
      });
    }
  }
  return parts;
}
