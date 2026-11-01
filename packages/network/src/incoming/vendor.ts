import { applyTrade } from '../trade';
import { text } from '../world';
import type { Decoder } from './decoder';

export const vendorPackets: [number, Decoder][] = [
  /*
  Vendor Sell List
  Server lists what a vendor will buy from the character, with prices.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Vendor serial
  BYTE[2] Item count
  Per item:
    BYTE[4] Serial
    BYTE[2] Graphic
    BYTE[2] Hue
    BYTE[2] Amount
    BYTE[2] Price
    BYTE[2] Name length
    BYTE[n] Name (ASCII)
  */
  [
    0x9e,
    (world, packet) => {
      const vendor = packet.readUInt32BE(3),
        count = packet.readUInt16BE(7);
      let offset = 9;
      const offers = [];
      for (let i = 0; i < count; i++) {
        const length = packet.readUInt16BE(offset + 12);
        offers.push({
          serial: packet.readUInt32BE(offset),
          graphic: packet.readUInt16BE(offset + 4),
          hue: packet.readUInt16BE(offset + 6),
          amount: packet.readUInt16BE(offset + 8),
          price: packet.readUInt16BE(offset + 10),
          name: text(packet, offset + 14, length)
        });
        offset += 14 + length;
      }
      if (offset !== packet.length) throw new Error('Invalid vendor sale list');
      world.sellOffers.set(vendor, offers);
    }
  ],
  /*
  Vendor Buy List
  Server prices the stock it just sent as Container Content (0x3C), item for item.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Stock container serial
  BYTE[1] Item count
  Per item:
    BYTE[4] Price
    BYTE[1] Description length
    BYTE[n] Description (ASCII)
  */
  [
    0x74,
    (world, packet) => {
      const container = packet.readUInt32BE(3);
      const count = packet.readUInt8(7);
      const vendor = world.entities.get(container)?.parent;
      const items = world.lastContainerContents
        .flatMap((serial) => {
          const item = world.entities.get(serial);
          const pack = item?.parent === undefined ? undefined : world.entities.get(item.parent);
          return item && (item.parent === container || (vendor !== undefined && pack?.parent === vendor)) ? [item] : [];
        })
        .sort((a, b) => (a.containerX ?? 0) - (b.containerX ?? 0));
      if (items.length !== count) throw new Error('Vendor price list does not match observed stock');
      const offers = [];
      let offset = 8;
      for (const item of items) {
        const price = packet.readUInt32BE(offset);
        const length = packet.readUInt8(offset + 4);
        offers.push({ serial: item.serial, price, description: text(packet, offset + 5, length) });
        offset += 5 + length;
      }
      if (offset !== packet.length) throw new Error('Invalid vendor price list');
      world.buyOffers.set(container, offers);
    }
  ],
  /*
  Secure Trade
  Server opens, updates or closes a trade window with another player (trade.ts reads each action).

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[1] Action (0 open, 1 close, 2 accept states, 3 gold, 4 update ledger)
  BYTE[4] First container serial
  BYTE[n] Action data
  */
  [
    0x6f,
    (world, packet) => {
      applyTrade(world, packet);
    }
  ]
];
