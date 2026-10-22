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
    ...(packet.length >= 73 ? { followers: packet.readUInt8(71), maxFollowers: packet.readUInt8(72) } : {})
  };
}
