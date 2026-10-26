import type { WorldView } from './world';

export function applyHealthBar(world: WorldView, packet: Buffer) {
  if (packet.length < 9) throw new Error('Truncated health-bar status');
  const count = packet.readUInt16BE(7);
  if (packet.length !== 9 + count * 3) throw new Error('Invalid health-bar status length');
  const mobile = world.entities.get(packet.readUInt32BE(3));
  if (mobile && mobile.serial !== world.serial) {
    for (let offset = 9; offset < packet.length; offset += 3)
      if (packet.readUInt16BE(offset) === 1)
        world.entities.set(mobile.serial, {
          ...mobile,
          flags: packet.readUInt8(offset + 2) > 0 ? (mobile.flags ?? 0) | 4 : (mobile.flags ?? 0) & ~4
        });
  }
  if (packet.readUInt32BE(3) === world.serial) {
    for (let offset = 9; offset < packet.length; offset += 3)
      if (packet.readUInt16BE(offset) === 1) world.poisonLevel = packet.readUInt8(offset + 2);
  }
}

export function applyPartyRoster(world: WorldView, packet: Buffer) {
  if (packet.readUInt16BE(3) === 0x06 && [1, 2].includes(packet.readUInt8(5))) {
    const remove = packet.readUInt8(5) === 2;
    const count = packet.readUInt8(6);
    const offset = remove ? 11 : 7;
    if (packet.length !== offset + count * 4) throw new Error('Invalid party member list');
    world.partyMembers.clear();
    for (let i = 0; i < count; i++) world.partyMembers.add(packet.readUInt32BE(offset + i * 4));
  }
}
