import type { Decoder } from './decoder';

export const itemPackets: [number, Decoder][] = [
  /*
  World Item
  Server shows an item lying in the world.

  Size: 24 bytes (26 from High Seas)

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Unknown (1)
  BYTE[1] Type (0 item, 1 multi)
  BYTE[4] Serial
  BYTE[2] Graphic
  BYTE[1] Direction
  BYTE[2] Amount
  BYTE[2] Amount
  BYTE[2] X
  BYTE[2] Y
  BYTE[1] Z
  BYTE[1] Light
  BYTE[2] Hue
  BYTE[1] Flags
  */
  [
    0xf3,
    (world, packet) => {
      world.put({
        serial: packet.readUInt32BE(4),
        kind: 'item',
        graphic: packet.readUInt16BE(8),
        amount: packet.readUInt16BE(11),
        position: { x: packet.readUInt16BE(15), y: packet.readUInt16BE(17), z: packet.readInt8(19), direction: 0 },
        flags: packet.readUInt8(23),
        hue: packet.readUInt16BE(21)
      });
    }
  ],
  /*
  Equip Update
  Server shows an item worn by a mobile.

  Size: 15 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Graphic
  BYTE[1] Unknown (0)
  BYTE[1] Layer
  BYTE[4] Wearer serial
  BYTE[2] Hue
  */
  [
    0x2e,
    (world, packet) => {
      world.put({
        serial: packet.readUInt32BE(1),
        kind: 'item',
        graphic: packet.readUInt16BE(5),
        layer: packet.readUInt8(8),
        parent: packet.readUInt32BE(9),
        hue: packet.readUInt16BE(13)
      });
    }
  ],
  /*
  Container Content Update
  Server adds or changes one item inside a container.

  Size: 21 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Graphic
  BYTE[1] Graphic offset
  BYTE[2] Amount
  BYTE[2] X in the container
  BYTE[2] Y in the container
  BYTE[1] Grid index
  BYTE[4] Container serial
  BYTE[2] Hue
  */
  [
    0x25,
    (world, packet) => {
      world.containerEntry(packet, 1);
    }
  ],
  /*
  Container Content
  Server lists everything inside an opened container (a vendor's stock comes the same way).

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[2] Item count
  Per item:
    BYTE[4] Serial
    BYTE[2] Graphic
    BYTE[1] Graphic offset
    BYTE[2] Amount
    BYTE[2] X in the container
    BYTE[2] Y in the container
    BYTE[1] Grid index
    BYTE[4] Container serial
    BYTE[2] Hue
  */
  [
    0x3c,
    (world, packet) => {
      const count = packet.readUInt16BE(3);
      if (packet.length !== 5 + count * 20) throw new Error('Invalid grid-container content length');
      const parents = new Set<number>();
      const present = new Set<number>();
      for (let i = 0; i < count; i++) {
        present.add(packet.readUInt32BE(5 + i * 20));
        parents.add(packet.readUInt32BE(19 + i * 20));
      }
      world.lastContainerContents = [...present];
      for (const parent of parents)
        for (const serial of [...world.entities.childSerials(parent)]) if (!present.has(serial)) world.remove(serial);
      for (let i = 0; i < count; i++) world.containerEntry(packet, 5 + i * 20);
    }
  ]
];
