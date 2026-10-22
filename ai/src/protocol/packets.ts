import type { Appearance } from '../appearance';
export const CLIENT_VERSION = '7.0.45.1';

export function ascii(value: string, maxBytes: number, label: string): Buffer {
  if (!value || !/^[\x20-\x7e]+$/.test(value) || Buffer.byteLength(value) >= maxBytes) {
    throw new Error(`${label} must contain 1–${maxBytes - 1} printable ASCII characters`);
  }
  const buffer = Buffer.alloc(maxBytes);
  buffer.write(value, 'ascii');
  return buffer;
}

export function variable(opcode: number, body: Buffer): Buffer {
  if (body.length + 3 > 65535) throw new Error('Packet too large');
  const buffer = Buffer.alloc(body.length + 3);
  buffer[0] = opcode;
  buffer.writeUInt16BE(buffer.length, 1);
  body.copy(buffer, 3);
  return buffer;
}

export function loginSeed(seed: number): Buffer {
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xef;
  buffer.writeUInt32BE(seed, 1);
  CLIENT_VERSION.split('.').forEach((part, index) => {
    buffer.writeUInt32BE(Number(part), 5 + index * 4);
  });
  return buffer;
}

export function accountLogin(username: string, password: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x80]),
    ascii(username, 30, 'Account name'),
    ascii(password, 30, 'Password'),
    Buffer.from([0xff])
  ]);
}

export function gameLogin(auth: number, username: string, password: string): Buffer {
  const buffer = Buffer.alloc(69);
  buffer.writeUInt32BE(auth, 0);
  buffer[4] = 0x91;
  buffer.writeUInt32BE(auth, 5);
  ascii(username, 30, 'Account name').copy(buffer, 9);
  ascii(password, 30, 'Password').copy(buffer, 39);
  return buffer;
}

export function selectServer(index: number): Buffer {
  const buffer = Buffer.from([0xa0, 0, 0]);
  buffer.writeUInt16BE(index, 1);
  return buffer;
}

export function playCharacter(name: string, slot: number): Buffer {
  const buffer = Buffer.alloc(73);
  buffer[0] = 0x5d;
  buffer.writeUInt32BE(0xedededed, 1);
  ascii(name, 30, 'Character name').copy(buffer, 5);
  buffer.writeUInt32BE(0x3f, 37);
  buffer.writeUInt32BE(slot, 65);
  return buffer;
}

export interface Creation {
  name: string;
  city: number;
  slot: number;
  skills: { id: number; value: number }[];
  // Sex, race, skin, hair and clothing colours (appearance.ts); a plain human man without it.
  appearance?: Appearance;
}

export function createCharacter(creation: Creation): Buffer {
  if (!/^[A-Za-z][A-Za-z .'-]{1,15}$/.test(creation.name))
    throw new Error('Character names must be 2–16 supported ASCII letters/punctuation');
  if (creation.skills.length > 3 || creation.skills.reduce((sum, s) => sum + s.value, 0) !== 100)
    throw new Error('This creation profile supports up to three skills totaling 100 points');
  if (new Set(creation.skills.map((s) => s.id)).size !== creation.skills.length)
    throw new Error('Duplicate creation skills');
  for (const skill of creation.skills)
    if (
      !Number.isInteger(skill.id) ||
      skill.id < 0 ||
      skill.id > 57 ||
      !Number.isInteger(skill.value) ||
      skill.value < 0 ||
      skill.value > 50
    )
      throw new Error('Invalid creation skill');
  const buffer = Buffer.alloc(104);
  buffer[0] = 0x00;
  buffer.writeUInt32BE(0xedededed, 1);
  buffer.writeUInt32BE(0xffffffff, 5);
  ascii(creation.name, 30, 'Character name').copy(buffer, 10);
  buffer.writeUInt32BE(0x3f, 42);
  const look = creation.appearance;
  // ServUO PacketHandlers.CreateCharacter: gender and race at 70, skin 80, hair 82/84, beard
  // 86/88, shirt and pants hues 100/102.
  buffer[70] = look?.genderRace ?? 2;
  buffer[71] = 40;
  buffer[72] = 30;
  buffer[73] = 10;
  creation.skills.forEach((skill, index) => {
    buffer[74 + index * 2] = skill.id;
    buffer[75 + index * 2] = skill.value;
  });
  buffer.writeUInt16BE(look?.skinHue ?? 0x03ea, 80);
  buffer.writeUInt16BE(look?.hair ?? 0, 82);
  buffer.writeUInt16BE(look?.hairHue ?? 0, 84);
  buffer.writeUInt16BE(look?.beard ?? 0, 86);
  buffer.writeUInt16BE(look?.beardHue ?? 0, 88);
  buffer[91] = creation.city;
  buffer.writeUInt32BE(creation.slot, 92);
  buffer.writeUInt16BE(look?.shirtHue ?? 0x0350, 100);
  buffer.writeUInt16BE(look?.pantsHue ?? 0x0350, 102);
  return buffer;
}

export function useItem(serial: number): Buffer {
  const buffer = Buffer.alloc(5);
  buffer[0] = 0x06;
  buffer.writeUInt32BE(serial, 1);
  return buffer;
}

export function queryStatus(serial: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer[0] = 0x34;
  buffer.writeUInt32BE(0xedededed, 1);
  buffer[5] = 4;
  buffer.writeUInt32BE(serial, 6);
  return buffer;
}

export function contextMenu(serial: number, entry?: number): Buffer {
  const body = Buffer.alloc(entry === undefined ? 6 : 8);
  body.writeUInt16BE(entry === undefined ? 0x13 : 0x15, 0);
  body.writeUInt32BE(serial, 2);
  if (entry !== undefined) body.writeUInt16BE(entry, 6);
  return variable(0xbf, body);
}

export function liftItem(serial: number, amount: number): Buffer {
  if (!Number.isInteger(amount) || amount < 1 || amount > 65535) throw new Error('Invalid lift amount');
  const buffer = Buffer.alloc(7);
  buffer[0] = 7;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(amount, 5);
  return buffer;
}

export function dropInto(serial: number, container: number): Buffer {
  const buffer = Buffer.alloc(15);
  buffer[0] = 8;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(0xffff, 5);
  buffer.writeUInt16BE(0xffff, 7);
  buffer.writeUInt32BE(container, 11);
  return buffer;
}

export function dropGround(serial: number, x: number, y: number, z: number): Buffer {
  const buffer = Buffer.alloc(15);
  buffer[0] = 8;
  buffer.writeUInt32BE(serial, 1);
  buffer.writeUInt16BE(x, 5);
  buffer.writeUInt16BE(y, 7);
  buffer.writeInt8(z, 9);
  buffer.writeUInt32BE(0xffffffff, 11);
  return buffer;
}

export function buyItem(vendor: number, serial: number, amount = 1): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(vendor, 0);
  body[4] = 2;
  body[5] = 0x1a;
  body.writeUInt32BE(serial, 6);
  body.writeUInt16BE(amount, 10);
  return variable(0x3b, body);
}

export function warMode(enabled: boolean): Buffer {
  return Buffer.from([0x72, Number(enabled), 0, 0x32, 0]);
}
export function attack(serial: number): Buffer {
  const packet = Buffer.alloc(5);
  packet[0] = 5;
  packet.writeUInt32BE(serial, 1);
  return packet;
}
export function equip(serial: number, layer: number, owner: number): Buffer {
  const packet = Buffer.alloc(10);
  packet[0] = 0x13;
  packet.writeUInt32BE(serial, 1);
  packet[5] = layer;
  packet.writeUInt32BE(owner, 6);
  return packet;
}
export function properties(serial: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(serial);
  return variable(0xd6, body);
}
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

export function walk(direction: number, sequence: number, running = false): Buffer {
  if (!Number.isInteger(direction) || direction < 0 || direction > 7) throw new Error('Direction must be 0–7');
  return Buffer.from([0x02, direction | (running ? 0x80 : 0), sequence, 0, 0, 0, 0]);
}

export function gumpReply(serial: number, id: number, button: number, switches: number[]): Buffer {
  const body = Buffer.alloc(20 + switches.length * 4);
  body.writeUInt32BE(serial, 0);
  body.writeUInt32BE(id, 4);
  body.writeUInt32BE(button, 8);
  body.writeUInt32BE(switches.length, 12);
  switches.forEach((value, index) => {
    body.writeUInt32BE(value, 16 + index * 4);
  });
  return variable(0xb1, body);
}

// Stat lock change (0xBF 0x1A): stat 0 str, 1 dex, 2 int; lock 0 up, 1 down, 2 locked.
export function statLock(stat: number, lock: number): Buffer {
  if (![0, 1, 2].includes(stat) || ![0, 1, 2].includes(lock)) throw new Error('Invalid stat lock');
  return variable(0xbf, Buffer.from([0x00, 0x1a, stat, lock]));
}

// Party commands (ServUO PartyMessage): 0x01 add (target cursor), 0x08 accept leader, 0x02 remove self.
export function party(command: 'add' | 'accept' | 'decline' | 'leave' | 'say', serial = 0, text = ''): Buffer {
  // Party chat to every member (PartyMessage_PublicMessage): big-endian Unicode, null-terminated.
  if (command === 'say') {
    if (!text.trim() || text.length > 128) throw new Error('Party message must contain 1–128 characters');
    const message = Buffer.from(`${text}\0`, 'utf16le').swap16();
    return variable(0xbf, Buffer.concat([Buffer.from([0x00, 0x06, 0x04]), message]));
  }
  const body = Buffer.alloc(command === 'add' ? 3 : 7);
  body.writeUInt16BE(0x06, 0);
  body[2] = { add: 0x01, leave: 0x02, accept: 0x08, decline: 0x09 }[command];
  if (command !== 'add') body.writeUInt32BE(serial, 3);
  return variable(0xbf, body);
}

// Skill lock change (0x3A, ServUO ChangeSkillLock): skill id, then lock 0 up, 1 down, 2 locked.
export function skillLock(skill: number, lock: number): Buffer {
  if (!Number.isInteger(skill) || skill < 0 || skill > 57 || ![0, 1, 2].includes(lock))
    throw new Error('Invalid skill lock');
  const body = Buffer.alloc(3);
  body.writeUInt16BE(skill, 0);
  body[2] = lock;
  return variable(0x3a, body);
}

// Skill use (0x12 type 0x24, "<id> 0"), as sent by the client's skill button.
// With `spell`, the same request casts spell `id` from the carried book (type 0x56).
export function useSkill(id: number, spell = false): Buffer {
  if (!Number.isInteger(id) || id < (spell ? 1 : 0) || id > (spell ? 64 : 57)) throw new Error('Invalid skill id');
  return variable(0x12, Buffer.from(spell ? `\x56${id}\0` : `\x24${id} 0\0`, 'latin1'));
}

const keywords = new Map([
  ['balance', 1],
  ['bank', 2],
  ['claim', 9],
  ['guards', 7],
  ['i renounce my young player status', 0x35],
  ['all stop', 0x167],
  ['all kill', 0x168],
  ['all guard me', 0x16b],
  ['all follow me', 0x16c]
]);

export function speech(text: string): Buffer {
  if (!text.trim() || text.length > 200 || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new Error('Speech must contain 1–200 characters without controls');
  // Speech IDs: 0x0000 withdraw, 0x0001 balance, 0x0002 bank (Banker.OnSpeech); 0x0007 guards
  // (GuardedRegion.OnSpeech); 0x0009 claim (AnimalTrainer); 0x0035 young renouncement (Keywords.cs);
  // pet orders from BaseAI.OnSpeech: 0x167 all stop, 0x168 all kill, 0x16B all guard me, 0x16C all follow me.
  const keyword = /^withdraw [1-9]\d{0,4}$/i.test(text) ? 0 : keywords.get(text.toLowerCase());
  if (keyword !== undefined) {
    const body = Buffer.alloc(12 + Buffer.byteLength(text, 'utf8') + 1);
    body[0] = 0xc0;
    body.writeUInt16BE(0x03b2, 1);
    body.writeUInt16BE(3, 3);
    body.write('ENU', 5, 'ascii');
    // Classic clients pack the keyword count and each speech ID into 12 bits.
    body[10] = 0x10 | (keyword >> 8);
    body[11] = keyword & 0xff;
    body.write(text, 12, 'utf8');
    return variable(0xad, body);
  }
  const body = Buffer.alloc(9 + (text.length + 1) * 2);
  body.writeUInt16BE(0x03b2, 1);
  body.writeUInt16BE(3, 3);
  body.write('ENU', 5, 'ascii');
  for (let i = 0; i < text.length; i++) body.writeUInt16BE(text.charCodeAt(i), 9 + i * 2);
  return variable(0xad, body);
}

export interface TargetCursor {
  id: number;
  ground: boolean;
  flags: number;
}
export interface TargetLocation {
  serial: number;
  x: number;
  y: number;
  z: number;
  graphic: number;
}

export function targetResponse(cursor: TargetCursor, target: TargetLocation | null): Buffer {
  const buffer = Buffer.alloc(19);
  buffer[0] = 0x6c;
  buffer[1] = target && target.serial === 0 ? 1 : 0;
  buffer.writeUInt32BE(cursor.id, 2);
  buffer[6] = cursor.flags;
  buffer.writeUInt32BE(target?.serial ?? 0, 7);
  buffer.writeUInt16BE(target?.x ?? 0xffff, 11);
  buffer.writeUInt16BE(target?.y ?? 0xffff, 13);
  buffer.writeInt16BE(target?.z ?? 0, 15);
  buffer.writeUInt16BE(target?.graphic ?? 0, 17);
  return buffer;
}

export const movementDeltas = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
] as const;
