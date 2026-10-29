import type { JournalEntry } from './world';
import { text, unicode } from './world';

// Journal entries from speech and localized-message packets: ASCII (0x1C) and Unicode (0xAE)
// speech carry a message type at byte 9; 0xC1 is a localized message; 0xCC is localized with an
// ASCII affix (for example a trainer's quoted price).
export function speechEntry(opcode: number, packet: Buffer): Omit<JournalEntry, 'at'> {
  const serial = packet.readUInt32BE(3);
  if (opcode === 0x1c)
    return {
      serial,
      name: text(packet, 14, 30),
      type: packet.readUInt8(9),
      text: text(packet, 44, packet.length - 44)
    };
  if (opcode === 0xae)
    return { serial, name: text(packet, 18, 30), type: packet.readUInt8(9), text: unicode(packet, 48) };
  if (opcode === 0xc1)
    return {
      serial,
      name: text(packet, 18, 30),
      cliloc: packet.readUInt32BE(14),
      arguments: unicode(packet, 48, true)
    };
  const end = packet.indexOf(0, 49);
  return {
    serial,
    name: text(packet, 19, 30),
    cliloc: packet.readUInt32BE(14),
    text: packet.subarray(49, end < 0 ? packet.length : end).toString('latin1')
  };
}
