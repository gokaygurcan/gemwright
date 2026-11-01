import { speechEntry } from '../speech';
import type { Decoder } from './decoder';

// Every spoken or system line becomes a journal entry (speech.ts reads each format).
const journal: Decoder = (world, packet, opcode) => {
  world.addJournal(speechEntry(opcode, packet));
};

export const messagePackets: [number, Decoder][] = [
  /*
  ASCII Message
  Server shows speech or a system line in plain text.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Speaker serial (0xFFFFFFFF for the system)
  BYTE[2] Speaker body
  BYTE[1] Message type
  BYTE[2] Hue
  BYTE[2] Font
  BYTE[30] Speaker name
  BYTE[n] Text (ASCII, null-terminated)
  */
  [0x1c, journal],
  /*
  Unicode Message
  Server shows speech or a system line in Unicode.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Speaker serial
  BYTE[2] Speaker body
  BYTE[1] Message type
  BYTE[2] Hue
  BYTE[2] Font
  BYTE[4] Language
  BYTE[30] Speaker name
  BYTE[n] Text (UTF-16BE, null-terminated)
  */
  [0xae, journal],
  /*
  Localized Message
  Server shows a cliloc line with its arguments.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Speaker serial
  BYTE[2] Speaker body
  BYTE[1] Message type
  BYTE[2] Hue
  BYTE[2] Font
  BYTE[4] Cliloc
  BYTE[30] Speaker name
  BYTE[n] Arguments (UTF-16LE, tab-separated, null-terminated)
  */
  [0xc1, journal],
  /*
  Localized Message Affix
  Server shows a cliloc line with text added before or after it.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Speaker serial
  BYTE[2] Speaker body
  BYTE[1] Message type
  BYTE[2] Hue
  BYTE[2] Font
  BYTE[4] Cliloc
  BYTE[1] Flags (1 prepend, 2 system, 4 no new line)
  BYTE[30] Speaker name
  BYTE[n] Affix (ASCII, null-terminated)
  BYTE[n] Arguments (UTF-16BE, null-terminated)
  */
  [0xcc, journal],
  /*
  Unicode Prompt
  Server asks the client to type a line of text (a rune name, an amount).

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Sender serial
  BYTE[4] Prompt id
  BYTE[4] Type
  BYTE[4] Language
  BYTE[n] Text (UTF-16LE)
  */
  [
    0xc2,
    (world, packet) => {
      world.prompt = { serial: packet.readUInt32BE(3), id: packet.readUInt32BE(7) };
    }
  ]
];
