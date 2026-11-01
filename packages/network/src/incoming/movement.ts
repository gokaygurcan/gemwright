import type { Decoder } from './decoder';

// Either answer to a move: the character's own entity takes the position the world view holds.
const placeSelf: Decoder = (world) => {
  const self = world.serial === null ? undefined : world.entities.get(world.serial);
  if (self && world.position) world.put({ ...self, position: { ...world.position } });
};

export const movementPackets: [number, Decoder][] = [
  /*
  Move Reject
  Server refuses a move request and puts the character back.

  Size: 8 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Sequence number of the refused move
  BYTE[2] X
  BYTE[2] Y
  BYTE[1] Direction
  BYTE[1] Z
  */
  [0x21, placeSelf],
  /*
  Move Acknowledge
  Server accepts a move request.

  Size: 3 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Sequence number of the accepted move
  BYTE[1] Notoriety of the character
  */
  [0x22, placeSelf],
  /*
  Mobile Update
  Server places the character anew (login, teleport, resurrection, body change).

  Size: 19 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Body
  BYTE[1] Unknown (0)
  BYTE[2] Hue
  BYTE[1] Flags
  BYTE[2] X
  BYTE[2] Y
  BYTE[2] Unknown (0)
  BYTE[1] Direction
  BYTE[1] Z
  */
  [
    0x20,
    (world, packet) => {
      world.put({
        serial: packet.readUInt32BE(1),
        kind: 'mobile',
        graphic: packet.readUInt16BE(5),
        flags: packet.readUInt8(10),
        position: {
          x: packet.readUInt16BE(11),
          y: packet.readUInt16BE(13),
          z: packet.readInt8(18),
          direction: packet.readUInt8(17) & 7
        }
      });
    }
  ]
];
