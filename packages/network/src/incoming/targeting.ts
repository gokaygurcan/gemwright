import type { Decoder } from './decoder';

export const targetingPackets: [number, Decoder][] = [
  /*
  Target Cursor
  Server asks the client to pick a target, or cancels the cursor it asked for.

  Size: 19 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Type (0 object, 1 ground)
  BYTE[4] Cursor id
  BYTE[1] Flags (0 neutral, 1 harmful, 2 beneficial, 3 cancel)
  BYTE[12] Unused (0)
  */
  [
    0x6c,
    (world, packet) => {
      world.target =
        packet.readUInt8(6) === 3
          ? null
          : { id: packet.readUInt32BE(2), ground: packet.readUInt8(1) === 1, flags: packet.readUInt8(6) };
    }
  ],
  /*
  Multi Target Cursor
  Server asks the client to place a multi (a house outline) on the ground.

  Size: 26 bytes (30 from High Seas)

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Ground allowed
  BYTE[4] Cursor id
  BYTE[1] Flags
  BYTE[11] Unused (0)
  BYTE[2] Multi id
  BYTE[2] Offset X
  BYTE[2] Offset Y
  BYTE[2] Offset Z
  */
  [
    0x99,
    (world, packet) => {
      world.target = {
        id: packet.readUInt32BE(2),
        ground: packet.readUInt8(1) === 1,
        flags: packet.readUInt8(6),
        multi: packet.readUInt16BE(18)
      };
    }
  ]
];
