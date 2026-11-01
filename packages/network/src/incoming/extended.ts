import { applyParty } from '../group-observations';
import type { Decoder } from './decoder';

export const extendedPackets: [number, Decoder][] = [
  /*
  Extended Command
  Server sends one of many sub-commands; the ones read here are:
  0x04 close a gump, 0x06 party, 0x08 map change, 0x14 context menu, 0x19 stat locks.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[2] Sub-command
  BYTE[n] Sub-command data
  */
  [
    0xbf,
    (world, packet) => {
      applyParty(world, packet);
      if (packet.readUInt16BE(3) === 0x14) {
        if (packet.readUInt16BE(5) !== 2) throw new Error('Unsupported context menu format');
        const serial = packet.readUInt32BE(7);
        const count = packet.readUInt8(11);
        if (packet.length !== 12 + count * 8) throw new Error('Invalid context menu length');
        const entries = [];
        for (let i = 0; i < count; i++)
          entries.push({
            cliloc: packet.readUInt32BE(12 + i * 8),
            index: packet.readUInt16BE(16 + i * 8),
            flags: packet.readUInt16BE(18 + i * 8)
          });
        if (world.contextMenus.size > 1000) {
          world.contextMenus.clear();
          world.observations.contextAt.clear();
        }
        world.contextMenus.set(serial, entries);
        world.observations.context(serial);
      }
      if (packet.readUInt16BE(3) === 8) world.map = packet.readUInt8(5);
      // StatLockInfo: two bits per stat (str, dex, int); 0 up, 1 down, 2 locked.
      if (packet.readUInt16BE(3) === 0x19 && packet.length >= 12 && packet.readUInt32BE(6) === world.serial) {
        const bits = packet.readUInt8(11);
        world.statLocks = [(bits >> 4) & 3, (bits >> 2) & 3, bits & 3];
      }
      if (packet.readUInt16BE(3) === 4) {
        const id = packet.readUInt32BE(5);
        for (const [key, gump] of world.gumps) if (gump.id === id) world.gumps.delete(key);
      }
    }
  ]
];
