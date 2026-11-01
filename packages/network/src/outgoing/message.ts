import { variable } from './encode';

const keywords = new Map([
  ['balance', 1],
  ['bank', 2],
  ['claim', 9],
  ['guards', 7],
  ['i renounce my young player status', 0x35],
  ['i wish to lock this down', 0x23],
  ['i wish to secure this', 0x25],
  ['all stop', 0x167],
  ['all kill', 0x168],
  ['all guard me', 0x16b],
  ['all follow me', 0x16c]
]);

/*
Unicode Speech Request
Client says a line. A line the server treats as a keyword (bank, balance, guards, pet orders)
carries its speech id, which the classic client packs in 12 bits after the type's 0xC0 flag.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[1] Type (0x0D guild chat; | 0xC0 when keywords follow)
BYTE[2] Hue
BYTE[2] Font
BYTE[4] Language ("ENU")
With keywords:
  BYTE[n] Keyword count and speech ids (12 bits each)
  BYTE[n] Text (UTF-8, null-terminated)
Without:
  BYTE[n] Text (UTF-16BE, null-terminated)
*/
export function speech(text: string, type = 0): Buffer {
  if (!text.trim() || text.length > 200 || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new Error('Speech must contain 1-200 characters without controls');
  // Speech IDs: 0x0000 withdraw, 0x0001 balance, 0x0002 bank (Banker.OnSpeech); 0x0007 guards
  // (GuardedRegion.OnSpeech); 0x0009 claim (AnimalTrainer); 0x0035 young renouncement (Keywords.cs);
  // 0x0023 lock down and 0x0025 secure (HouseRegion.OnSpeech);
  // pet orders from BaseAI.OnSpeech: 0x167 all stop, 0x168 all kill, 0x16B all guard me, 0x16C all follow me.
  const keyword = /^withdraw [1-9]\d{0,4}$/i.test(text) ? 0 : keywords.get(text.toLowerCase());
  if (keyword !== undefined) {
    const body = Buffer.alloc(12 + Buffer.byteLength(text, 'utf8') + 1);
    body[0] = 0xc0 | type;
    body.writeUInt16BE(0x03b2, 1);
    body.writeUInt16BE(3, 3);
    body.write('ENU', 5, 'ascii');
    // Classic clients pack the keyword count and each speech ID into 12 bits.
    body[10] = 0x10 | (keyword >> 8);
    body[11] = keyword & 0xff;
    body.write(text, 12, 'utf8');
    return variable(0xad, body);
  }
  const body = Buffer.alloc(9 + (text.length + 1) * 2);
  body[0] = type;
  body.writeUInt16BE(0x03b2, 1);
  body.writeUInt16BE(3, 3);
  body.write('ENU', 5, 'ascii');
  for (let i = 0; i < text.length; i++) body.writeUInt16BE(text.charCodeAt(i), 9 + i * 2);
  return variable(0xad, body);
}

/*
Unicode Prompt Response
Client answers a prompt the server sent (0xC2), or cancels it.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Sender serial
BYTE[4] Prompt id
BYTE[4] Type (1 answer, 0 cancel)
BYTE[4] Language ("ENU")
BYTE[n] Text (UTF-16LE)
*/
export function promptReply(serial: number, prompt: number, text: string | null): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(serial, 0);
  head.writeUInt32BE(prompt, 4);
  head.writeUInt32BE(text === null ? 0 : 1, 8);
  head.write('ENU', 12, 'ascii');
  return variable(0xc2, Buffer.concat([head, Buffer.from(text ?? '', 'utf16le')]));
}
