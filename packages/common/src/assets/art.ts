import { join } from 'node:path';

import type { Hues } from './hues';
import { color16, type Image } from './png';
import { Uop } from './uop';

// Gump and item art from the UOP containers, hued, as RGBA images.
type Hue = { hues: Hues; hue: number; partial?: boolean };

function pixel(rgba: Uint8Array, at: number, c: number, hue?: Hue) {
  const value = hue?.hue ? hue.hues.apply(c, hue.hue, hue.partial) : c;
  const [r, g, b] = color16(value);
  rgba.set([r, g, b, 255], at * 4);
}

// gumpartLegacyMUL.uop: width and height, then one offset per row (in 4-byte units from the
// row table) to runs of (colour, length); colour 0 is transparent.
export class GumpArt {
  private readonly uop: Uop;
  constructor(directory: string) {
    this.uop = new Uop(join(directory, 'gumpartLegacyMUL.uop'));
  }

  get(id: number, hue?: Hue): Image | undefined {
    const data = this.uop.read(`build/gumpartlegacymul/${String(id).padStart(8, '0')}.tga`);
    if (!data || data.length < 8) return undefined;
    const width = data.readUInt32LE(0);
    const height = data.readUInt32LE(4);
    const rgba = new Uint8Array(width * height * 4);
    const start = 8;
    const quads = (data.length - start) >> 2;
    for (let y = 0; y < height; y++) {
      const row = data.readInt32LE(start + y * 4);
      const end = y < height - 1 ? data.readInt32LE(start + (y + 1) * 4) : quads;
      let x = 0;
      for (let at = start + row * 4; at < start + end * 4; at += 4) {
        const c = data.readUInt16LE(at);
        const run = data.readUInt16LE(at + 2);
        if (c) for (let i = 0; i < run && x + i < width; i++) pixel(rgba, y * width + x + i, c, hue);
        x += run;
      }
    }
    return { width, height, rgba };
  }
}

// artLegacyMUL.uop: items are entries 0x4000 + graphic: a 4-byte header, width, height, one
// offset per line (in 2-byte units from the end of the table) to runs of (x skip, length,
// colours…), each line ended by (0, 0).
export class ItemArt {
  private readonly uop: Uop;
  constructor(directory: string) {
    this.uop = new Uop(join(directory, 'artLegacyMUL.uop'));
  }

  get(graphic: number, hue?: Hue): Image | undefined {
    const data = this.uop.read(`build/artlegacymul/${String(graphic + 0x4000).padStart(8, '0')}.tga`);
    if (!data || data.length < 8) return undefined;
    const width = data.readUInt16LE(4);
    const height = data.readUInt16LE(6);
    if (!width || !height) return undefined;
    const rgba = new Uint8Array(width * height * 4);
    const table = 8;
    const runs = table + height * 2;
    for (let y = 0; y < height; y++) {
      let at = runs + data.readUInt16LE(table + y * 2) * 2;
      let x = 0;
      for (;;) {
        const skip = data.readUInt16LE(at);
        const run = data.readUInt16LE(at + 2);
        at += 4;
        if (skip + run === 0 || skip + run >= 2048) break;
        x += skip;
        for (let i = 0; i < run; i++, at += 2) {
          const c = data.readUInt16LE(at);
          if (c && x + i < width) pixel(rgba, y * width + x + i, c, hue);
        }
        x += run;
      }
    }
    return { width, height, rgba };
  }
}
