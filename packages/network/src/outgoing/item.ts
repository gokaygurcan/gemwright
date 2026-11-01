import { variable } from './encode';

/*
Double Click
Client uses an item or mobile (opens, equips, activates, asks for a paperdoll).

Size: 5 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
*/
export function useItem(serial: number): Buffer {
  const buffer = Buffer.alloc(5);
  buffer[0] = 0x06;
  buffer.writeUInt32BE(serial, 1);
  return buffer;
}

/*
Lift Request
Client picks up an item, or part of a stack.

Size: 7 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
BYTE[2] Amount
*/
export function liftItem(serial: number, amount: number): Buffer {
  if (!Number.isInteger(amount) || amount < 1 || amount > 65535) throw new Error('Invalid lift amount');
  const buffer = Buffer.alloc(7);
  buffer[0] = 0x07;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(amount, 5);
  return buffer;
}

/*
Drop Request (into a container)
Client drops the lifted item into a container.

Size: 15 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
BYTE[2] X (0xFFFF: anywhere)
BYTE[2] Y (0xFFFF: anywhere)
BYTE[1] Z
BYTE[1] Grid index
BYTE[4] Container serial
*/
export function dropInto(serial: number, container: number): Buffer {
  const buffer = Buffer.alloc(15);
  buffer[0] = 0x08;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(0xffff, 5);
  buffer.writeUInt16BE(0xffff, 7);
  buffer.writeUInt32BE(container, 11);
  return buffer;
}

/*
Drop Request (on the ground)
Client drops the lifted item on a tile.

Size: 15 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
BYTE[2] X
BYTE[2] Y
BYTE[1] Z
BYTE[1] Grid index
BYTE[4] Container serial (0xFFFFFFFF: the ground)
*/
export function dropGround(serial: number, x: number, y: number, z: number): Buffer {
  const buffer = Buffer.alloc(15);
  buffer[0] = 0x08;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(x, 5);
  buffer.writeUInt16BE(y, 7);
  buffer.writeInt8(z, 9);
  buffer.writeUInt32BE(0xffffffff, 11);
  return buffer;
}

/*
Wear Item
Client puts the lifted item on a mobile.

Size: 10 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
BYTE[1] Layer
BYTE[4] Wearer serial
*/
export function equip(serial: number, layer: number, owner: number): Buffer {
  const packet = Buffer.alloc(10);
  packet[0] = 0x13;
  packet.writeUInt32BE(serial, 1);
  packet[5] = layer;
  packet.writeUInt32BE(owner, 6);
  return packet;
}

/*
Object Property List Request
Client asks for an item's or mobile's properties (the tooltip).

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Serial
*/
export function properties(serial: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(serial);
  return variable(0xd6, body);
}
