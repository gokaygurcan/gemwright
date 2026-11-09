import { inflateSync } from 'node:zlib';

export interface HouseDesign {
  revision: number;
  tiles: number;
  planes: { id: number; data: Buffer }[];
}

// ServUO DesignStateDetailed: bounded zlib planes plus explicit stair tiles.
export function decodeHouseDesign(packet: Buffer): { serial: number; design: HouseDesign } {
  if (
    packet.length < 18 ||
    packet.readUInt16BE(1) !== packet.length ||
    packet[3] !== 3 ||
    packet.readUInt16BE(15) !== packet.length - 17 ||
    packet.readUInt8(17) > 15
  )
    throw new Error('Invalid house design header');
  const planes: HouseDesign['planes'] = [];
  const ids = new Set<number>();
  let offset = 18;
  for (let i = 0; i < packet.readUInt8(17); i++) {
    if (offset + 4 > packet.length) throw new Error('Truncated house design plane');
    const id = packet.readUInt8(offset);
    const size = packet.readUInt8(offset + 1) | ((packet.readUInt8(offset + 3) & 0xf0) << 4);
    const compressed = packet.readUInt8(offset + 2) | ((packet.readUInt8(offset + 3) & 15) << 8);
    offset += 4;
    if (
      ids.has(id) ||
      !((id >= 0x20 && id <= 0x28) || (id >= 9 && id <= 14)) ||
      !size ||
      size > 8192 ||
      !compressed ||
      offset + compressed > packet.length
    )
      throw new Error('Invalid house design plane');
    const data = inflateSync(packet.subarray(offset, offset + compressed), { maxOutputLength: 8192 });
    if (data.length !== size || data.length % (id < 0x20 ? 5 : 2)) throw new Error('Invalid house design payload');
    ids.add(id);
    planes.push({ id, data });
    offset += compressed;
  }
  if (offset !== packet.length) throw new Error('Trailing house design data');
  return {
    serial: packet.readUInt32BE(5),
    design: { revision: packet.readUInt32BE(9), tiles: packet.readUInt16BE(13), planes }
  };
}
