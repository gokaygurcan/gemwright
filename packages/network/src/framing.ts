// Wire lengths for the 7.0.45.1 classic-client profile, checked against ServUO pub57.
// Zero denotes a variable packet with a big-endian length at bytes 1–2.
export const packetLengths: Readonly<Record<number, number>> = {
  11: 7,
  17: 0,
  21: 9,
  22: 0,
  23: 0,
  26: 0,
  27: 37,
  28: 0,
  29: 5,
  32: 19,
  33: 8,
  34: 3,
  35: 26,
  36: 9,
  37: 21,
  39: 2,
  43: 2,
  44: 2,
  45: 17,
  46: 15,
  47: 10,
  56: 7,
  58: 0,
  59: 8,
  60: 0,
  78: 6,
  79: 2,
  83: 2,
  84: 12,
  85: 1,
  91: 4,
  101: 4,
  108: 19,
  109: 3,
  110: 14,
  111: 0,
  112: 28,
  114: 5,
  115: 2,
  116: 0,
  118: 16,
  119: 17,
  120: 0,
  123: 2,
  124: 0,
  129: 0,
  130: 2,
  133: 2,
  134: 0,
  136: 66,
  137: 0,
  139: 0,
  140: 11,
  149: 9,
  151: 2,
  152: 0,
  153: 30,
  158: 0,
  161: 9,
  162: 9,
  163: 9,
  165: 0,
  166: 0,
  168: 0,
  169: 0,
  170: 5,
  174: 0,
  175: 13,
  176: 0,
  183: 0,
  184: 0,
  185: 5,
  186: 10,
  188: 3,
  189: 0,
  190: 0,
  191: 0,
  192: 36,
  193: 0,
  194: 0,
  195: 0,
  198: 1,
  199: 49,
  200: 2,
  201: 6,
  202: 6,
  203: 7,
  204: 0,
  209: 2,
  211: 0,
  214: 0,
  220: 9,
  221: 0,
  223: 0,
  226: 10,
  229: 0,
  230: 5,
  243: 26
};

export class PacketFramer {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    if (this.pending.length + chunk.length > 1024 * 1024) throw new Error('Protocol receive buffer exceeded 1 MiB');
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const packets: Buffer[] = [];
    let offset = 0;
    while (offset < this.pending.length) {
      const opcode = this.pending.readUInt8(offset);
      let length = packetLengths[opcode];
      if (length === undefined)
        throw new Error(`Unsupported incoming opcode 0x${opcode.toString(16)}; refusing to guess packet boundaries`);
      if (length === 0) {
        if (this.pending.length - offset < 3) break;
        length = this.pending.readUInt16BE(offset + 1);
        if (length < 3) throw new Error('Invalid variable packet length');
      }
      if (this.pending.length - offset < length) break;
      packets.push(this.pending.subarray(offset, offset + length));
      offset += length;
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return packets;
  }

  finish(): void {
    if (this.pending.length) throw new Error('Connection ended with a truncated protocol packet');
  }
}
