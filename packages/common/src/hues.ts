import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// hues.mul: groups of eight hues after a 4-byte header; each hue is 32 colours, a table range and
// a 20-byte name (88 bytes). A hued pixel takes the colour its red channel indexes; a partial hue
// recolours only grey pixels (equal red, green and blue).
export class Hues {
  private readonly bytes: Buffer;
  constructor(directory: string) {
    this.bytes = readFileSync(join(directory, 'hues.mul'));
  }

  apply(c: number, hue: number, partial = false): number {
    const index = (hue & 0x3fff) - 1;
    if (index < 0 || c === 0) return c;
    const offset = (index >> 3) * 708 + 4 + (index & 7) * 88;
    if (offset + 64 > this.bytes.length) return c;
    if (partial) {
      const r = (c >> 10) & 0x1f;
      if (r !== ((c >> 5) & 0x1f) || r !== (c & 0x1f)) return c;
    }
    return this.bytes.readUInt16LE(offset + ((c >> 10) & 0x1f) * 2) | 0x8000;
  }
}
