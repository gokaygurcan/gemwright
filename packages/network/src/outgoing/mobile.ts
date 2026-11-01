/*
Mobile Query
Client asks for a mobile's status (type 4) or skills (type 5).

Size: 10 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Pattern (0xEDEDEDED)
BYTE[1] Type
BYTE[4] Serial
*/
export function queryStatus(serial: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer[0] = 0x34;
  buffer.writeUInt32BE(0xedededed, 1);
  buffer[5] = 4;
  buffer.writeUInt32BE(serial, 6);
  return buffer;
}

/*
Attack Request
Client attacks a mobile.

Size: 5 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Serial
*/
export function attack(serial: number): Buffer {
  const packet = Buffer.alloc(5);
  packet[0] = 0x05;
  packet.writeUInt32BE(serial, 1);
  return packet;
}
