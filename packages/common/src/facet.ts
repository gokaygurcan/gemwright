import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { color16, type Image } from './png';
import { Uop } from './uop';

// One facet's terrain from the client files, for drawing a radar like the client's: map blocks
// of 8x8 cells (a 4-byte header, then per cell a land tile and its z), and statics listed per
// block (staidx: offset, length; statics: tile, x, y, z, hue). radarcol.mul gives each land tile
// (0..0x3FFF) and item tile (0x4000 + id) a 16-bit colour.
const SIZES: Record<number, [number, number]> = {
  0: [7168, 4096], // Felucca
  1: [7168, 4096], // Trammel
  2: [2304, 1600], // Ilshenar
  3: [2560, 2048], // Malas
  4: [1448, 1448], // Tokuno
  5: [1280, 4096] // Ter Mur
};

let radarColors: Buffer | undefined;

export class Facet {
  readonly width: number;
  readonly height: number;
  private readonly map: Buffer;
  private readonly index: Buffer;
  private readonly statics: Buffer;
  private readonly colors: Buffer;

  constructor(directory: string, facet: number) {
    const size = SIZES[facet];
    if (!size) throw new Error(`Unknown facet ${facet}`);
    [this.width, this.height] = size;
    const uop = new Uop(join(directory, `map${facet}LegacyMUL.uop`));
    const chunks: Buffer[] = [];
    const expected = ((this.width * this.height) / 64) * 196;
    for (let i = 0, total = 0; total < expected; i++) {
      const chunk = uop.read(`build/map${facet}legacymul/${String(i).padStart(8, '0')}.dat`);
      if (!chunk) throw new Error(`Missing map chunk ${i} of facet ${facet}`);
      chunks.push(chunk);
      total += chunk.length;
    }
    this.map = Buffer.concat(chunks);
    const statics = join(directory, `statics${facet}.mul`);
    this.index = existsSync(statics) ? readFileSync(join(directory, `staidx${facet}.mul`)) : Buffer.alloc(0);
    this.statics = existsSync(statics) ? readFileSync(statics) : Buffer.alloc(0);
    radarColors ??= readFileSync(join(directory, 'radarcol.mul'));
    this.colors = radarColors;
  }

  // The top-down colours of a size×size square centred on (x, y), one pixel per tile: the
  // highest static on a cell, else its land.
  radar(cx: number, cy: number, size: number): Image {
    const rgba = new Uint8Array(size * size * 4);
    const x0 = cx - (size >> 1);
    const y0 = cy - (size >> 1);
    const top = new Map<number, { z: number; color: number }>();
    for (let by = (y0 >> 3) - 1; by <= (y0 + size) >> 3; by++)
      for (let bx = (x0 >> 3) - 1; bx <= (x0 + size) >> 3; bx++) {
        if (bx < 0 || by < 0 || bx >= this.width >> 3 || by >= this.height >> 3) continue;
        const entry = (bx * (this.height >> 3) + by) * 12;
        if (entry + 12 > this.index.length) continue;
        const start = this.index.readInt32LE(entry);
        const length = this.index.readInt32LE(entry + 4);
        if (start < 0 || length <= 0) continue;
        for (let at = start; at + 7 <= start + length; at += 7) {
          const x = (bx << 3) + this.statics.readUInt8(at + 2);
          const y = (by << 3) + this.statics.readUInt8(at + 3);
          const z = this.statics.readInt8(at + 4);
          const key = y * this.width + x;
          const seen = top.get(key);
          if (!seen || z >= seen.z)
            top.set(key, { z, color: this.colors.readUInt16LE((0x4000 + this.statics.readUInt16LE(at)) * 2) });
        }
      }
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const cell = ((x >> 3) * (this.height >> 3) + (y >> 3)) * 196 + 4 + ((y & 7) * 8 + (x & 7)) * 3;
        const land = this.map.readUInt16LE(cell);
        const z = this.map.readInt8(cell + 2);
        const st = top.get(y * this.width + x);
        const c = st && st.z >= z ? st.color : this.colors.readUInt16LE(land * 2);
        const [r, g, b] = color16(c);
        rgba.set([r, g, b, 255], (dy * size + dx) * 4);
      }
    return { width: size, height: size, rgba };
  }
}
