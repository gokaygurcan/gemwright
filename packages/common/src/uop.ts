import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { bwtDecompress } from './bwt';

// The client's UOP containers (MYP): files addressed by the hash of their name, such as
// `build/gumpartlegacymul/00000123.tga`, each stored plain, zlib-compressed, or zlib-compressed
// after a BWT (bwt.ts).

// Bob Jenkins' hashlittle2, as the client hashes UOP entry names.
export function nameHash(name: string): bigint {
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

interface Entry {
  start: number;
  length: number;
  size: number;
  // 0 plain, 1 zlib, 3 zlib then BWT.
  flag: number;
}

export class Uop {
  private readonly bytes: Buffer;
  private readonly entries = new Map<bigint, Entry>();

  constructor(path: string) {
    this.bytes = readFileSync(path);
    if (this.bytes.readUInt32LE(0) !== 0x0050594d) throw new Error(`Not a UOP file: ${path}`);
    const visited = new Set<number>();
    for (let block = Number(this.bytes.readBigUInt64LE(12)); block !== 0; ) {
      if (visited.has(block)) throw new Error(`Cyclic UOP: ${path}`);
      visited.add(block);
      const count = this.bytes.readUInt32LE(block);
      for (let i = 0; i < count; i++) {
        const at = block + 12 + i * 34;
        const offset = Number(this.bytes.readBigUInt64LE(at));
        if (!offset) continue;
        this.entries.set(this.bytes.readBigUInt64LE(at + 20), {
          start: offset + this.bytes.readUInt32LE(at + 8),
          length: this.bytes.readUInt32LE(at + 12),
          size: this.bytes.readUInt32LE(at + 16),
          flag: this.bytes.readUInt16LE(at + 32)
        });
      }
      block = Number(this.bytes.readBigUInt64LE(block + 4));
    }
  }

  // An entry's bytes by its name, decompressed; undefined when the container lacks it.
  read(name: string): Buffer | undefined {
    const entry = this.entries.get(nameHash(name));
    if (!entry) return undefined;
    const bytes = this.bytes.subarray(entry.start, entry.start + entry.length);
    if (entry.flag === 1) return inflateSync(bytes);
    if (entry.flag === 3) return Buffer.from(bwtDecompress(inflateSync(bytes)));
    return bytes;
  }
}
