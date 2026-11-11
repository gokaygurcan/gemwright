import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Link } from './links';
import { logger } from './log';
import { buildWalkGraph, type Ground, type WalkGraphData } from './walk-graph-build';

type Gates = Record<string, { x: number; y: number; z?: number }>;
const arrays = ['x', 'y', 'z', 'kind', 'from', 'to', 'cost'] as const;
const types = {
  x: Uint16Array,
  y: Uint16Array,
  z: Int8Array,
  kind: Uint8Array,
  from: Int32Array,
  to: Int32Array,
  cost: Uint16Array
};

// The walk graph for this map, teleporters and gates: the copy in `directory` when its fingerprint
// (the map files, the teleporters, the gates) matches, else built now (a couple of minutes, once
// per map or world), saved, and older copies removed. Saved as its arrays, raw, after a line of
// JSON saying their lengths and the gates.
export async function useWalkGraph(
  directory: string,
  terrain: Ground,
  assets: string,
  teleporters: Link[],
  gates: Gates
) {
  const hash = createHash('sha256').update(JSON.stringify({ version: 1, teleporters, gates }));
  for (const name of readdirSync(assets).sort()) hash.update(`${name}:${statSync(join(assets, name)).size}`);
  const fingerprint = hash.digest('hex').slice(0, 16);
  const file = join(directory, `walk-graph-${fingerprint}.bin`);
  if (existsSync(file)) return read(readFileSync(file));
  const started = performance.now();
  logger('walk-graph').info('[walk-graph] learning how the land joins up on foot, by teleporter and by gate');
  const data = await buildWalkGraph(terrain, teleporters, gates);
  for (const old of readdirSync(directory).filter((name) => /^walk-graph-[0-9a-f]+\.bin$/.test(name)))
    rmSync(join(directory, old), { force: true });
  writeFileSync(file, write(data));
  logger('walk-graph').info(
    `[walk-graph] ${data.x.length} nodes, ${data.from.length} edges, in ${Math.round((performance.now() - started) / 1000)} s`
  );
  return data;
}

function write(data: WalkGraphData) {
  const head = Buffer.from(
    `${JSON.stringify({ gates: data.gates, lengths: arrays.map((name) => data[name].length) })}\n`
  );
  const parts = arrays.map((name) => Buffer.from(data[name].buffer, data[name].byteOffset, data[name].byteLength));
  // Each array starts on an 8-byte boundary, so it can be read back in place.
  const padded: Buffer[] = [head];
  let offset = head.length;
  for (const part of parts) {
    const pad = (8 - (offset % 8)) % 8;
    padded.push(Buffer.alloc(pad), part);
    offset += pad + part.length;
  }
  return Buffer.concat(padded);
}

function read(file: Buffer): WalkGraphData {
  const end = file.indexOf(10);
  const head = JSON.parse(file.subarray(0, end).toString()) as { gates: Record<string, number>; lengths: number[] };
  const out: Partial<WalkGraphData> = { gates: head.gates };
  let offset = end + 1;
  arrays.forEach((name, i) => {
    offset += (8 - (offset % 8)) % 8;
    const Type = types[name];
    const length = head.lengths[i] ?? 0;
    const bytes = new Uint8Array(file.subarray(offset, offset + length * Type.BYTES_PER_ELEMENT));
    (out as Record<string, unknown>)[name] = new Type(bytes.buffer);
    offset += length * Type.BYTES_PER_ELEMENT;
  });
  return out as WalkGraphData;
}
