import { gumpLayout } from '../gumps';
import type { Decoder } from './decoder';

// Both forms open a gump the resident can answer (gumps.ts reads the layout either way).
const openGump: Decoder = (world, packet, opcode) => {
  if (world.gumps.size >= 100) throw new Error('Open gump limit exceeded');
  const serial = packet.readUInt32BE(3);
  const id = packet.readUInt32BE(7);
  world.gumps.set(`${serial}:${id}`, { serial, id, packed: opcode === 0xdd, layout: gumpLayout(packet) });
};

export const gumpPackets: [number, Decoder][] = [
  /*
  Gump
  Server opens a gump: its layout of controls and its text lines.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[4] Gump id
  BYTE[4] X
  BYTE[4] Y
  BYTE[2] Layout length
  BYTE[n] Layout (ASCII commands in braces)
  BYTE[2] Text line count
  Per line:
    BYTE[2] Length in characters
    BYTE[n] Text (UTF-16BE)
  */
  [0xb0, openGump],
  /*
  Compressed Gump
  Server opens a gump whose layout and text are zlib-compressed.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[4] Gump id
  BYTE[4] X
  BYTE[4] Y
  BYTE[4] Compressed layout length (+ 4)
  BYTE[4] Layout length
  BYTE[n] Compressed layout
  BYTE[4] Text line count
  BYTE[4] Compressed text length (+ 4)
  BYTE[4] Text length
  BYTE[n] Compressed text
  */
  [0xdd, openGump]
];
