import { variable } from './encode';

/*
Buy Items
Client buys from a vendor's stock.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Vendor serial
BYTE[1] Flag (2 buy)
Per item:
  BYTE[1] Layer (0x1A stock)
  BYTE[4] Serial
  BYTE[2] Amount
*/
export function buyItem(vendor: number, serial: number, amount = 1): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(vendor, 0);
  body[4] = 2;
  body[5] = 0x1a;
  body.writeUInt32BE(serial, 6);
  body.writeUInt16BE(amount, 10);
  return variable(0x3b, body);
}

/*
Sell List Reply
Client sells items to a vendor from its sell list (0x9E).

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[4] Vendor serial
BYTE[2] Item count
Per item:
  BYTE[4] Serial
  BYTE[2] Amount
*/
export function sellItems(vendor: number, items: { serial: number; amount: number }[]): Buffer {
  if (
    !items.length ||
    items.length >= 100 ||
    items.some((item) => !Number.isInteger(item.amount) || item.amount < 1 || item.amount > 32767)
  )
    throw new Error('Invalid sale size or quantity');
  const body = Buffer.alloc(6 + items.length * 6);
  body.writeUInt32BE(vendor, 0);
  body.writeUInt16BE(items.length, 4);
  items.forEach((item, index) => {
    body.writeUInt32BE(item.serial, 6 + index * 6);
    body.writeUInt16BE(item.amount, 10 + index * 6);
  });
  return variable(0x9f, body);
}
