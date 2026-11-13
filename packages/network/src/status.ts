import type { WorldView } from './world';

export interface PlayerStatus {
  hits: number;
  maxHits: number;
  stamina: number;
  maxStamina: number;
  mana: number;
  maxMana: number;
  gold: number;
  strength: number;
  dexterity: number;
  intelligence: number;
  armor: number;
  weight: number;
  maxWeight: number;
  followers?: number;
  maxFollowers?: number;
  statCap?: number;
  // Fire, cold, poison and energy; physical is `armor`.
  resists?: { fire: number; cold: number; poison: number; energy: number };
  luck?: number;
  damage?: { min: number; max: number };
}

export function playerStatus(packet: Buffer): PlayerStatus {
  if (packet.length < 69 || packet.readUInt8(42) < 5) throw new Error('Unsupported player status');
  return {
    hits: packet.readUInt16BE(37),
    maxHits: packet.readUInt16BE(39),
    stamina: packet.readUInt16BE(50),
    maxStamina: packet.readUInt16BE(52),
    mana: packet.readUInt16BE(54),
    maxMana: packet.readUInt16BE(56),
    gold: packet.readUInt32BE(58),
    strength: packet.readUInt16BE(44),
    dexterity: packet.readUInt16BE(46),
    intelligence: packet.readUInt16BE(48),
    armor: packet.readUInt16BE(62),
    weight: packet.readUInt16BE(64),
    maxWeight: packet.readUInt16BE(66),
    ...(packet.length >= 73
      ? { statCap: packet.readUInt16BE(69), followers: packet.readUInt8(71), maxFollowers: packet.readUInt8(72) }
      : {}),
    ...(packet.length >= 87
      ? {
          resists: {
            fire: packet.readInt16BE(73),
            cold: packet.readInt16BE(75),
            poison: packet.readInt16BE(77),
            energy: packet.readInt16BE(79)
          },
          luck: packet.readInt16BE(81),
          damage: { min: packet.readUInt16BE(83), max: packet.readUInt16BE(85) }
        }
      : {})
  };
}

export function recordHealth(world: WorldView, hits: number, maxHits: number): void {
  if (!world.status || world.status.hits === hits) return;
  const adjustedPrevious = world.status.hits - Math.max(0, world.status.maxHits - maxHits);
  world.healthChanges.push({
    at: Date.now(),
    hits,
    maxHits,
    damage: Math.max(0, adjustedPrevious - hits),
    healed: Math.max(0, hits - world.status.hits)
  });
  if (world.healthChanges.length > 128) world.healthChanges.shift();
}
