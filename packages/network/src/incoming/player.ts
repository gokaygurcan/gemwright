import type { Decoder } from './decoder';

export const playerPackets: [number, Decoder][] = [
  /*
  Skill List / Skill Update
  Server sends the character's skills: the full list, or one skill that changed.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[1] Format (0x02 full list with caps, 0xDF one skill with cap)
  Per skill:
    BYTE[2] Skill id (full list: id + 1; terminated by 0)
    BYTE[2] Value (tenths)
    BYTE[2] Base (tenths)
    BYTE[1] Lock (0 up, 1 down, 2 locked)
    BYTE[2] Cap (tenths)
  */
  [
    0x3a,
    (world, packet) => {
      const format = packet.readUInt8(3);
      if (format !== 2 && format !== 0xdf) throw new Error('Unsupported skill observation format');
      if (format === 0xdf && packet.length !== 13) throw new Error('Invalid skill delta');
      let offset = 4;
      while (offset < packet.length) {
        const wireId = packet.readUInt16BE(offset);
        offset += 2;
        if (format === 2 && wireId === 0) {
          if (offset !== packet.length) throw new Error('Invalid skill terminator');
          break;
        }
        const id = format === 2 ? wireId - 1 : wireId;
        if (id < 0 || id > 57 || offset + 7 > packet.length) throw new Error('Invalid observed skill');
        world.skills.set(id, {
          value: packet.readUInt16BE(offset) / 10,
          base: packet.readUInt16BE(offset + 2) / 10,
          lock: packet.readUInt8(offset + 4),
          cap: packet.readUInt16BE(offset + 5) / 10
        });
        world.observations.skill(id);
        offset += 7;
      }
    }
  ],
  /*
  Death Status
  Server tells the character it died, or that it lives again.

  Size: 2 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Status (0 dead, 2 alive)
  */
  [
    0x2c,
    (world, packet) => {
      if (packet.readUInt8(1) === 0 && world.position) world.deathSite = { ...world.position };
    }
  ],
  /*
  Change Combatant
  Server names the character's current combat opponent.

  Size: 5 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Opponent serial (0 for none)
  */
  [
    0xaa,
    (world, packet) => {
      world.combatant = packet.readUInt32BE(1) || null;
    }
  ],
  /*
  War Mode
  Server confirms the character's war or peace stance.

  Size: 5 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Flag (0 peace, 1 war)
  BYTE[3] Unknown (0x00 0x32 0x00)
  */
  [
    0x72,
    (world, packet) => {
      world.warMode = packet.readUInt8(1) !== 0;
    }
  ],
  /*
  Client View Range
  Server sets how far the character sees, in tiles.

  Size: 2 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Range
  */
  [
    0xc8,
    (world, packet) => {
      world.viewRange = packet.readUInt8(1);
    }
  ]
];
