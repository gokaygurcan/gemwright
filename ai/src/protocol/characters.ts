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
