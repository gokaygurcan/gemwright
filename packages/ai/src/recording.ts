import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlayerSession } from '@gemwright/network/session';
import { speechEntry } from '@gemwright/network/speech';

import { tapEvents, traceContext } from './telemetry';
import type { TelemetryEvent } from './telemetry-schema';

// A full recording of one resident (online.json `record: true`): every packet both ways (raw
// bytes, opcode, decoded fields where they decode simply), every action the arbiter saw (walk steps
// included), every log line, life event and decision. JSON lines, one file per UTC hour, under
// recordings/<name>-<id> in the data folder. Login packets carry the account password and are
// recorded without their bytes.

type Writer = { dir: string; lines: string[]; writing: Promise<void> };
const writers = new Map<string, Writer>();
const residentOf = new WeakMap<PlayerSession, string>();
const SECRET = new Set([0x80, 0x91]);

// Client packet names (the actions a player's client sends); server packets are named by opcode only.
const OUT: Record<number, string> = {
  0: 'create-character',
  2: 'walk',
  5: 'attack',
  6: 'double-click',
  7: 'pick-up',
  8: 'drop',
  9: 'single-click',
  18: 'text-command',
  19: 'equip',
  34: 'resync',
  44: 'resurrection-menu',
  52: 'status-request',
  58: 'skill-lock',
  59: 'buy',
  93: 'play-character',
  108: 'target',
  111: 'secure-trade',
  114: 'war-mode',
  115: 'ping',
  125: 'menu-response',
  128: 'account-login',
  145: 'game-login',
  149: 'dye',
  155: 'help',
  159: 'sell',
  160: 'select-server',
  173: 'speech',
  177: 'gump-response',
  189: 'client-version',
  191: 'general',
  200: 'update-range',
  214: 'tooltip-request',
  215: 'encoded-command',
  239: 'login-seed'
};

function decodeOut(packet: Buffer): Record<string, unknown> | undefined {
  const op = packet[0];
  if (op === 0x02) return { direction: packet[1], sequence: packet[2] };
  if ((op === 0x05 || op === 0x06 || op === 0x09) && packet.length >= 5) return { serial: packet.readUInt32BE(1) };
  if (op === 0x07 && packet.length >= 7) return { serial: packet.readUInt32BE(1), amount: packet.readUInt16BE(5) };
  if (op === 0x6c && packet.length >= 19)
    return {
      type: packet[1],
      cursor: packet.readUInt32BE(2),
      serial: packet.readUInt32BE(7),
      x: packet.readUInt16BE(11),
      y: packet.readUInt16BE(13),
      z: packet.readInt16BE(15),
      graphic: packet.readUInt16BE(17)
    };
  if (op === 0xad && packet.length > 12) {
    const keywords = (packet[3] ?? 0) >= 0xc0;
    if (keywords) {
      const count = ((packet[12] ?? 0) << 4) | ((packet[13] ?? 0) >> 4);
      const start = 12 + Math.ceil((12 + count * 12) / 8);
      return { type: packet[3], keywords: count, text: packet.subarray(start).toString('utf8').replace(/\0+$/, '') };
    }
    return {
      type: packet[3],
      text: Buffer.from(packet.subarray(12, packet.length - (packet.length % 2)))
        .swap16()
        .toString('utf16le')
        .replace(/\0+$/, '')
    };
  }
  if (op === 0xb1 && packet.length >= 15)
    return { serial: packet.readUInt32BE(3), gump: packet.readUInt32BE(7), button: packet.readUInt32BE(11) };
  if (op === 0xbf && packet.length >= 5) return { subcommand: packet.readUInt16BE(3) };
  if (op === 0xd6) {
    const serials: number[] = [];
    for (let at = 3; at + 4 <= packet.length; at += 4) serials.push(packet.readUInt32BE(at));
    return { serials };
  }
}

function decodeIn(packet: Buffer): Record<string, unknown> | undefined {
  const op = packet[0] ?? -1;
  if ([0x1c, 0xae, 0xc1, 0xcc].includes(op)) {
    try {
      return { ...speechEntry(op, packet) };
    } catch {
      return { undecoded: 'speech' };
    }
  }
}

function write(residentId: string, entry: Record<string, unknown>) {
  const writer = writers.get(residentId);
  if (!writer) return;
  writer.lines.push(JSON.stringify(entry));
}

async function flush(writer: Writer) {
  if (!writer.lines.length) return;
  const lines = writer.lines.splice(0);
  const file = join(writer.dir, `${new Date().toISOString().slice(0, 13)}.jsonl`);
  writer.writing = writer.writing.then(() => appendFile(file, `${lines.join('\n')}\n`));
  await writer.writing;
}

export async function startRecording(dataDirectory: string, residentId: string, name: string) {
  if (writers.has(residentId)) return;
  const dir = join(dataDirectory, 'recordings', `${name.replace(/[^\w-]+/g, '-')}-${residentId.slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const writer: Writer = { dir, lines: [], writing: Promise.resolve() };
  writers.set(residentId, writer);
  setInterval(() => void flush(writer).catch((error) => console.error(`[recording] ${error}`)), 1000).unref();
  write(residentId, { at: new Date().toISOString(), kind: 'recording-started', residentId, name });
}

export const recording = (residentId: string) => writers.has(residentId);

// Every packet of this session, in order, with the position and the action it was sent under.
export function recordSession(session: PlayerSession, residentId: string) {
  if (!writers.has(residentId)) return;
  residentOf.set(session, residentId);
  session.tap = (direction, packet) => {
    const opcode = packet[0] ?? -1;
    const context = traceContext();
    write(residentId, {
      at: new Date().toISOString(),
      kind: 'packet',
      direction,
      opcode: `0x${opcode.toString(16).padStart(2, '0')}`,
      name: direction === 'out' ? OUT[opcode] : undefined,
      length: packet.length,
      hex: SECRET.has(opcode) && direction === 'out' ? '[credentials withheld]' : packet.toString('hex'),
      decoded: direction === 'out' ? decodeOut(packet) : decodeIn(packet),
      position: session.world.position,
      intentId: context?.intentId,
      actionId: context?.actionId
    });
  };
}

// What it believes about itself (self-state.ts), each time that changes.
export function recordSelf(session: PlayerSession, self: object) {
  const residentId = residentOf.get(session);
  if (residentId) write(residentId, { at: new Date().toISOString(), kind: 'self', self });
}

// Every arbiter event, walk steps and observations included (the journal leaves those out).
export function recordAction(session: PlayerSession, event: object) {
  const residentId = residentOf.get(session);
  if (residentId) write(residentId, { at: new Date().toISOString(), kind: 'action', event });
}

export function recordDecision(residentId: string, decision: object) {
  write(residentId, { at: new Date().toISOString(), kind: 'decision', decision });
}

tapEvents((event: TelemetryEvent) => {
  if (event.residentId && writers.has(event.residentId)) write(event.residentId, { kind: 'event', ...event });
});
