import { variable } from './encode';

/*
Context Menu Request / Response (Extended Command 0x13 / 0x15)
Client asks for a mobile's or item's context menu, or picks one of its entries.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[2] Sub-command (0x13 request, 0x15 response)
BYTE[4] Serial
BYTE[2] Entry index (response only)
*/
export function contextMenu(serial: number, entry?: number): Buffer {
  const body = Buffer.alloc(entry === undefined ? 6 : 8);
  body.writeUInt16BE(entry === undefined ? 0x13 : 0x15, 0);
  body.writeUInt32BE(serial, 2);
  if (entry !== undefined) body.writeUInt16BE(entry, 6);
  return variable(0xbf, body);
}

/*
Stat Lock Change (Extended Command 0x1A)
Client sets one stat to rise, fall or stay locked.

Size: 7 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[2] Sub-command
BYTE[1] Stat (0 strength, 1 dexterity, 2 intelligence)
BYTE[1] Lock (0 up, 1 down, 2 locked)
*/
export function statLock(stat: number, lock: number): Buffer {
  if (![0, 1, 2].includes(stat) || ![0, 1, 2].includes(lock)) throw new Error('Invalid stat lock');
  return variable(0xbf, Buffer.from([0x00, 0x1a, stat, lock]));
}

/*
Party Command (Extended Command 0x06)
Client invites (a target cursor follows), accepts, declines, leaves, or speaks to the party.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[2] Sub-command
BYTE[1] Party command (0x01 add, 0x02 remove, 0x04 public message, 0x08 accept, 0x09 decline)
BYTE[4] Serial (remove, accept, decline)
BYTE[n] Message (public message: UTF-16BE, null-terminated)
*/
export function party(command: 'add' | 'accept' | 'decline' | 'leave' | 'say', serial = 0, text = ''): Buffer {
  // Party chat to every member (PartyMessage_PublicMessage): big-endian Unicode, null-terminated.
  if (command === 'say') {
    if (!text.trim() || text.length > 128) throw new Error('Party message must contain 1-128 characters');
    const message = Buffer.from(`${text}\0`, 'utf16le').swap16();
    return variable(0xbf, Buffer.concat([Buffer.from([0x00, 0x06, 0x04]), message]));
  }
  const body = Buffer.alloc(command === 'add' ? 3 : 7);
  body.writeUInt16BE(0x06, 0);
  body[2] = { add: 0x01, leave: 0x02, accept: 0x08, decline: 0x09 }[command];
  if (command !== 'add') body.writeUInt32BE(serial, 3);
  return variable(0xbf, body);
}

/*
Encoded Command 0x28: Guild Button
Client presses the paperdoll's Guild button.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Serial
BYTE[2] Encoded command
BYTE[1] Terminator (0x0A)
*/
export function guildButton(serial: number): Buffer {
  const body = Buffer.alloc(7);
  body.writeUInt32BE(serial, 0);
  body.writeUInt16BE(0x28, 4);
  body[6] = 0x0a;
  return variable(0xd7, body);
}
