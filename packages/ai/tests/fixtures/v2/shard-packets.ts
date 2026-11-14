import { HUMAN_BODIES } from '@gemwright/common/game/bodies';
import { variable } from '@gemwright/network/packets';

// Server packets, as ServUO sends them, applied straight to a world view: the test shard's voice.

export function loginConfirm(serial: number, x: number, y: number, z: number, direction: number): Buffer {
  const packet = Buffer.alloc(37);
  packet[0] = 0x1b;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(400, 9);
  packet.writeUInt16BE(x, 11);
  packet.writeUInt16BE(y, 13);
  packet.writeInt16BE(z, 15);
  packet[17] = direction & 7;
  return packet;
}

export function mobileIncoming(
  serial: number,
  body: number,
  x: number,
  y: number,
  z: number,
  direction: number,
  worn: { serial: number; graphic: number; layer: number }[] = []
): Buffer {
  const packet = Buffer.alloc(19 + worn.length * 9 + 4);
  packet[0] = 0x78;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt32BE(serial, 3);
  packet.writeUInt16BE(body, 7);
  packet.writeUInt16BE(x, 9);
  packet.writeUInt16BE(y, 11);
  packet.writeInt8(z, 13);
  packet[14] = direction & 7;
  // As ServUO shows them (Notoriety.MobileNotoriety): people innocent, a wild creature attackable.
  packet[18] = HUMAN_BODIES.has(body) ? 1 : 3;
  worn.forEach((item, index) => {
    const at = 19 + index * 9;
    packet.writeUInt32BE(item.serial, at);
    packet.writeUInt16BE(item.graphic, at + 4);
    packet[at + 6] = item.layer;
  });
  return packet;
}

export function worldItem(serial: number, graphic: number, x: number, y: number, z: number): Buffer {
  const packet = Buffer.alloc(24);
  packet[0] = 0xf3;
  packet.writeUInt16BE(1, 1);
  packet.writeUInt32BE(serial, 4);
  packet.writeUInt16BE(graphic, 8);
  packet.writeUInt16BE(1, 11);
  packet.writeUInt16BE(x, 15);
  packet.writeUInt16BE(y, 17);
  packet.writeInt8(z, 19);
  return packet;
}

export function gump(serial: number, id: number, layout: string): Buffer {
  const bytes = Buffer.from(layout, 'ascii');
  const packet = Buffer.alloc(21 + bytes.length + 2);
  packet[0] = 0xb0;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt32BE(serial, 3);
  packet.writeUInt32BE(id, 7);
  packet.writeUInt32BE(100, 11);
  packet.writeUInt32BE(100, 15);
  packet.writeUInt16BE(bytes.length, 19);
  bytes.copy(packet, 21);
  return packet;
}

export function itemInContainer(serial: number, graphic: number, amount: number, parent: number): Buffer {
  const packet = Buffer.alloc(21);
  packet[0] = 0x25;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(graphic, 5);
  packet.writeUInt16BE(amount, 8);
  packet.writeUInt16BE(40, 10);
  packet.writeUInt16BE(60, 12);
  packet.writeUInt32BE(parent, 15);
  return packet;
}

export function containerContents(
  entries: { serial: number; graphic: number; amount: number }[],
  parent: number
): Buffer {
  const packet = Buffer.alloc(5 + entries.length * 20);
  packet[0] = 0x3c;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt16BE(entries.length, 3);
  entries.forEach((entry, index) => {
    const at = 5 + index * 20;
    packet.writeUInt32BE(entry.serial, at);
    packet.writeUInt16BE(entry.graphic, at + 4);
    packet.writeUInt16BE(entry.amount, at + 7);
    packet.writeUInt32BE(parent, at + 14);
  });
  return packet;
}

export function removeEntity(serial: number): Buffer {
  const packet = Buffer.alloc(5);
  packet[0] = 0x1d;
  packet.writeUInt32BE(serial, 1);
  return packet;
}

export function systemText(text: string): Buffer {
  const bytes = Buffer.from(text, 'ascii');
  const packet = Buffer.alloc(45 + bytes.length);
  packet[0] = 0x1c;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt32BE(0xffffffff, 3);
  packet[9] = 6;
  packet.writeUInt16BE(3, 12);
  packet.write('System', 14, 'ascii');
  bytes.copy(packet, 44);
  return packet;
}

// What a mobile in view says (0x1c ASCII speech): its serial and name, and the words.
export function speech(serial: number, name: string, text: string): Buffer {
  const bytes = Buffer.from(text, 'ascii');
  const packet = Buffer.alloc(45 + bytes.length);
  packet[0] = 0x1c;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt32BE(serial, 3);
  packet.writeUInt16BE(401, 7);
  packet.writeUInt16BE(3, 12);
  packet.write(name, 14, 'ascii');
  bytes.copy(packet, 44);
  return packet;
}

export function skillUpdate(skill: number, value: number): Buffer {
  const body = Buffer.alloc(10);
  body[0] = 0xdf;
  body.writeUInt16BE(skill, 1);
  body.writeUInt16BE(value, 3);
  body.writeUInt16BE(value, 5);
  body.writeUInt16BE(1000, 8);
  return variable(0x3a, body);
}

export function targetCursor(id: number): Buffer {
  const packet = Buffer.alloc(19);
  packet[0] = 0x6c;
  packet[1] = 1;
  packet.writeUInt32BE(id, 2);
  return packet;
}

export function contextMenuData(serial: number, entries: { cliloc: number; index: number }[]): Buffer {
  const body = Buffer.alloc(9 + entries.length * 8);
  body.writeUInt16BE(0x14, 0);
  body.writeUInt16BE(2, 2);
  body.writeUInt32BE(serial, 4);
  body[8] = entries.length;
  entries.forEach((entry, index) => {
    body.writeUInt32BE(entry.cliloc, 9 + index * 8);
    body.writeUInt16BE(entry.index, 13 + index * 8);
  });
  return variable(0xbf, body);
}

export function sellList(
  vendor: number,
  offers: { serial: number; graphic: number; amount: number; price: number; name: string }[]
): Buffer {
  const body = Buffer.alloc(6 + offers.reduce((sum, offer) => sum + 14 + offer.name.length, 0));
  body.writeUInt32BE(vendor, 0);
  body.writeUInt16BE(offers.length, 4);
  let at = 6;
  for (const offer of offers) {
    body.writeUInt32BE(offer.serial, at);
    body.writeUInt16BE(offer.graphic, at + 4);
    body.writeUInt16BE(offer.amount, at + 8);
    body.writeUInt16BE(offer.price, at + 10);
    body.writeUInt16BE(offer.name.length, at + 12);
    body.write(offer.name, at + 14, 'ascii');
    at += 14 + offer.name.length;
  }
  return variable(0x9e, body);
}

export function stockPrices(container: number, price: number): Buffer {
  const description = 'pickaxe';
  const body = Buffer.alloc(10 + description.length);
  body.writeUInt32BE(container, 0);
  body[4] = 1;
  body.writeUInt32BE(price, 5);
  body[9] = description.length;
  body.write(description, 10, 'ascii');
  return variable(0x74, body);
}

export function propertyList(serial: number, cliloc: number, args: string): Buffer {
  const text = Buffer.from(`${args}\0`, 'utf16le');
  const packet = Buffer.alloc(21 + text.length);
  packet[0] = 0xd6;
  packet.writeUInt16BE(packet.length, 1);
  packet.writeUInt16BE(1, 3);
  packet.writeUInt32BE(serial, 5);
  packet.writeUInt32BE(cliloc, 15);
  packet.writeUInt16BE(text.length, 19);
  text.copy(packet, 21);
  return packet;
}

export function nameReply(serial: number, name: string): Buffer {
  const packet = Buffer.alloc(37);
  packet[0] = 0x98;
  packet.writeUInt16BE(37, 1);
  packet.writeUInt32BE(serial, 3);
  packet.write(name, 7, 'ascii');
  return packet;
}

// The character's full status (0x11 type 5): what its client knows of its body (status.ts reads it).
export function characterStatus(
  serial: number,
  fields: {
    name?: string;
    hits: number;
    maxHits: number;
    strength?: number;
    dexterity?: number;
    intelligence?: number;
    stamina?: number;
    maxStamina?: number;
    mana?: number;
    maxMana?: number;
    gold?: number;
    armor?: number;
    weight?: number;
    maxWeight?: number;
  }
): Buffer {
  const packet = Buffer.alloc(73);
  packet[0] = 0x11;
  packet.writeUInt16BE(73, 1);
  packet.writeUInt32BE(serial, 3);
  packet.write(fields.name ?? 'Resident', 7, 'ascii');
  packet.writeUInt16BE(fields.hits, 37);
  packet.writeUInt16BE(fields.maxHits, 39);
  packet[41] = 1;
  packet[42] = 5;
  packet.writeUInt16BE(fields.strength ?? 100, 44);
  packet.writeUInt16BE(fields.dexterity ?? 100, 46);
  packet.writeUInt16BE(fields.intelligence ?? 100, 48);
  packet.writeUInt16BE(fields.stamina ?? 100, 50);
  packet.writeUInt16BE(fields.maxStamina ?? 100, 52);
  packet.writeUInt16BE(fields.mana ?? 100, 54);
  packet.writeUInt16BE(fields.maxMana ?? 100, 56);
  packet.writeUInt32BE(fields.gold ?? 0, 58);
  packet.writeUInt16BE(fields.armor ?? 0, 62);
  packet.writeUInt16BE(fields.weight ?? 0, 64);
  packet.writeUInt16BE(fields.maxWeight ?? 550, 66);
  return packet;
}

// The server naming the character's combat opponent (0xaa), or none.
export function combatTarget(serial: number): Buffer {
  const packet = Buffer.alloc(5);
  packet[0] = 0xaa;
  packet.writeUInt32BE(serial, 1);
  return packet;
}

export function warMode(enabled: boolean): Buffer {
  const packet = Buffer.alloc(5);
  packet[0] = 0x72;
  packet[1] = enabled ? 1 : 0;
  packet[3] = 0x32;
  return packet;
}

// The swing the server confirms to the attacker (0x2f), whom it hit, and how hard (0x0b).
export function swing(attacker: number, target: number): Buffer {
  const packet = Buffer.alloc(10);
  packet[0] = 0x2f;
  packet.writeUInt32BE(attacker, 2);
  packet.writeUInt32BE(target, 6);
  return packet;
}

export function damage(serial: number, amount: number): Buffer {
  const packet = Buffer.alloc(7);
  packet[0] = 0x0b;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(amount, 5);
  return packet;
}

// A mobile dying (0xaf) and the corpse it leaves.
export function death(killed: number, corpse: number): Buffer {
  const packet = Buffer.alloc(13);
  packet[0] = 0xaf;
  packet.writeUInt32BE(killed, 1);
  packet.writeUInt32BE(corpse, 5);
  return packet;
}

export function hits(serial: number, maxHits: number, hits: number): Buffer {
  const packet = Buffer.alloc(9);
  packet[0] = 0xa1;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(maxHits, 5);
  packet.writeUInt16BE(hits, 7);
  return packet;
}

// An old-style swing animation (0x6e), as a fight in view shows.
export function animation(serial: number, action: number): Buffer {
  const packet = Buffer.alloc(14);
  packet[0] = 0x6e;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(action, 5);
  packet.writeUInt16BE(0, 7);
  return packet;
}
