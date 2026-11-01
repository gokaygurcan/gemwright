import type { Decoder } from './decoder';

export const entityPackets: [number, Decoder][] = [
  /*
  Object Property List
  Server sends an item's or mobile's properties (the tooltip), each a cliloc with arguments.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[2] Unknown (1)
  BYTE[4] Serial
  BYTE[2] Unknown (0)
  BYTE[4] Revision hash
  Per property:
    BYTE[4] Cliloc (0 ends the list)
    BYTE[2] Argument length in bytes
    BYTE[n] Arguments (UTF-16LE)
  */
  [
    0xd6,
    (world, packet) => {
      const serial = packet.readUInt32BE(5),
        properties = [];
      let offset = 15;
      while (offset + 4 <= packet.length) {
        const cliloc = packet.readUInt32BE(offset);
        offset += 4;
        if (!cliloc) break;
        const length = packet.readUInt16BE(offset);
        offset += 2;
        if (length % 2 || offset + length > packet.length) throw new Error('Invalid object property text');
        properties.push({ cliloc, arguments: packet.subarray(offset, offset + length).toString('utf16le') });
        offset += length;
      }
      const entity = world.entities.get(serial);
      if (entity) world.put({ ...entity, properties });
    }
  ],
  /*
  Remove Entity
  Server removes an item or mobile from view; what it contained goes with it.

  Size: 5 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  */
  [
    0x1d,
    (world, packet) => {
      const pending = [packet.readUInt32BE(1)];
      for (let serial = pending.pop(); serial !== undefined; serial = pending.pop()) {
        pending.push(...world.entities.childSerials(serial));
        world.remove(serial);
      }
    }
  ]
];
