import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// tiledata.mul (the 64-bit flags format): land tiles, then item tiles in groups of 32 after a
// 4-byte header. An item record is 41 bytes: flags (8), weight, quality (the equipment layer),
// misc (2), unknown, quantity, animation (the paperdoll gump, 2), unknown, hue, stacking offset,
// value, height, name (20).
const ITEMS = 512 * (4 + 32 * 30);
const PARTIAL_HUE = 0x00040000;

export interface ItemTile {
  name: string;
  weight: number;
  layer: number;
  animation: number;
  height: number;
  partialHue: boolean;
}

export class Tiledata {
  private readonly bytes: Buffer;
  constructor(directory: string) {
    this.bytes = readFileSync(join(directory, 'tiledata.mul'));
  }

  item(id: number): ItemTile {
    const at = ITEMS + (id >> 5) * (4 + 32 * 41) + 4 + (id & 31) * 41;
    if (at + 41 > this.bytes.length)
      return { name: '', weight: 0, layer: 0, animation: 0, height: 0, partialHue: false };
    return {
      name:
        this.bytes
          .subarray(at + 21, at + 41)
          .toString('latin1')
          .split('\0')[0] ?? '',
      weight: this.bytes.readUInt8(at + 8),
      layer: this.bytes.readUInt8(at + 9),
      animation: this.bytes.readUInt16LE(at + 14),
      height: this.bytes.readUInt8(at + 20),
      partialHue: !!(this.bytes.readUInt32LE(at) & PARTIAL_HUE)
    };
  }
}

// Tiledata flags as the shard reads them (ServUO TileFlag, low 32 bits). The reader above returns raw
// bits; consumers name them here instead of writing 0x400000 in a dozen modules.
export const TileFlag = {
  Background: 0x00000001,
  Weapon: 0x00000002,
  Transparent: 0x00000004,
  Translucent: 0x00000008,
  Wall: 0x00000010,
  Damaging: 0x00000020,
  Impassable: 0x00000040,
  Wet: 0x00000080,
  Surface: 0x00000200,
  Bridge: 0x00000400,
  Generic: 0x00000800,
  Window: 0x00001000,
  NoShoot: 0x00002000,
  Foliage: 0x00020000,
  PartialHue: 0x00040000,
  Map: 0x00100000,
  Container: 0x00200000,
  Wearable: 0x00400000,
  LightSource: 0x00800000,
  Animation: 0x01000000,
  Armor: 0x08000000,
  Door: 0x20000000,
  StairBack: 0x40000000
} as const;
