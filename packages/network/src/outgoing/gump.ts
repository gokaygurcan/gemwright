import { variable } from './encode';

/*
Gump Response
Client answers a gump: the button pressed, the switches set and the text entered.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Serial
BYTE[4] Gump id
BYTE[4] Button id (0 closes)
BYTE[4] Switch count
BYTE[4] Per switch: id
BYTE[4] Text entry count
Per text entry:
  BYTE[2] Entry id
  BYTE[2] Length in characters
  BYTE[n] Text (UTF-16BE)
*/
export function gumpReply(
  serial: number,
  id: number,
  button: number,
  switches: number[],
  texts: { id: number; text: string }[] = []
): Buffer {
  const entries = texts.map((entry) => {
    if (entry.text.length > 239) throw new Error('Gump text entry is too long');
    const head = Buffer.alloc(4);
    head.writeUInt16BE(entry.id, 0);
    head.writeUInt16BE(entry.text.length, 2);
    return Buffer.concat([head, Buffer.from(entry.text, 'utf16le').swap16()]);
  });
  const body = Buffer.alloc(20 + switches.length * 4);
  body.writeUInt32BE(serial, 0);
  body.writeUInt32BE(id, 4);
  body.writeUInt32BE(button, 8);
  body.writeUInt32BE(switches.length, 12);
  switches.forEach((value, index) => {
    body.writeUInt32BE(value, 16 + index * 4);
  });
  body.writeUInt32BE(texts.length, 16 + switches.length * 4);
  return variable(0xb1, Buffer.concat([body, ...entries]));
}
