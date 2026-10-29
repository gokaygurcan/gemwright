import { text } from './world';

export interface City {
  index: number;
  name: string;
  building: string;
}

// The character list (0xA9): character names by slot, then the starting cities offered.
export function characterList(packet: Buffer): { characters: string[]; cities: City[] } {
  const count = packet.readUInt8(3);
  if (count > 7) throw new Error('Unsupported character slot count');
  const characters = Array.from({ length: count }, (_, i) => text(packet, 4 + i * 60, 30));
  let offset = 4 + count * 60;
  const cities: City[] = [];
  const cityCount = packet.readUInt8(offset++);
  for (let i = 0; i < cityCount; i++, offset += 89) {
    if (offset + 89 > packet.length) throw new Error('Truncated city list');
    cities.push({
      index: packet.readUInt8(offset),
      name: text(packet, offset + 1, 32),
      building: text(packet, offset + 33, 32)
    });
  }
  return { characters, cities };
}

// Server list (0xA8): each entry's index and name.
export function serverList(packet: Buffer): { index: number; name: string }[] {
  const count = packet.readUInt16BE(4);
  if (count > 100 || packet.length !== 6 + count * 40) throw new Error('Invalid server list');
  return Array.from({ length: count }, (_, i) => ({
    index: packet.readUInt16BE(6 + i * 40),
    name: text(packet, 8 + i * 40, 32)
  }));
}
