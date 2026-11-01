import type { Decoder } from './decoder';

export const accountPackets: [number, Decoder][] = [
  /*
  Login Confirm
  Server confirms the character entering the world: who it is and where it stands.

  Size: 37 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Character serial
  BYTE[4] Unknown (0)
  BYTE[2] Body
  BYTE[2] X
  BYTE[2] Y
  BYTE[2] Z
  BYTE[1] Direction
  BYTE[19] Map size and unknown fields
  */
  [
    0x1b,
    (world, packet) => {
      world.serial = packet.readUInt32BE(1);
      world.position = {
        x: packet.readUInt16BE(11),
        y: packet.readUInt16BE(13),
        z: packet.readInt16BE(15),
        direction: packet.readUInt8(17) & 7
      };
    }
  ],
  /*
  Login Complete
  Server finished sending the world: the character can act.

  Size: 1 byte

  Packet Build
  BYTE[1] Packet identifier
  */
  [
    0x55,
    (world) => {
      world.ready = true;
    }
  ]
];
