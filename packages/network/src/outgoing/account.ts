import type { Appearance } from '../appearance';
import { ascii } from './encode';

/*
Login Seed
Client opens the login connection: a seed and its version.

Size: 21 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Seed
BYTE[4] Major version
BYTE[4] Minor version
BYTE[4] Revision
BYTE[4] Prototype
*/
export function loginSeed(seed: number, version: string): Buffer {
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xef;
  buffer.writeUInt32BE(seed, 1);
  version.split('.').forEach((part, index) => {
    buffer.writeUInt32BE(Number(part), 5 + index * 4);
  });
  return buffer;
}

/*
Account Login
Client logs in to the account.

Size: 62 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[30] Account name
BYTE[30] Password
BYTE[1] Next login key (0xFF)
*/
export function accountLogin(username: string, password: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x80]),
    ascii(username, 30, 'Account name'),
    ascii(password, 30, 'Password'),
    Buffer.from([0xff])
  ]);
}

/*
Game Server Login
Client logs in to the game server with the key the login server gave it (the key goes first,
unprefixed, as the connection's seed).

Size: 65 bytes (after the 4-byte key)

Packet Build
BYTE[1] Packet identifier
BYTE[4] Authentication key
BYTE[30] Account name
BYTE[30] Password
*/
export function gameLogin(auth: number, username: string, password: string): Buffer {
  const buffer = Buffer.alloc(69);
  buffer.writeUInt32BE(auth, 0);
  buffer[4] = 0x91;
  buffer.writeUInt32BE(auth, 5);
  ascii(username, 30, 'Account name').copy(buffer, 9);
  ascii(password, 30, 'Password').copy(buffer, 39);
  return buffer;
}

/*
Select Server
Client picks a shard from the server list.

Size: 3 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[2] Server index
*/
export function selectServer(index: number): Buffer {
  const buffer = Buffer.from([0xa0, 0, 0]);
  buffer.writeUInt16BE(index, 1);
  return buffer;
}

/*
Play Character
Client enters the world as an existing character.

Size: 73 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Pattern (0xEDEDEDED)
BYTE[30] Character name
BYTE[2] Unknown (0)
BYTE[4] Client flags (0x3F)
BYTE[24] Unknown (0)
BYTE[4] Slot
BYTE[4] Client IP (0)
*/
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

/*
Create Character
Client creates a character: name, stats, skills, appearance and starting city.

Size: 104 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[4] Pattern (0xEDEDEDED)
BYTE[4] Pattern (0xFFFFFFFF)
BYTE[1] Unknown (0)
BYTE[30] Character name
BYTE[2] Unknown (0)
BYTE[4] Client flags (0x3F)
BYTE[24] Unknown (0)
BYTE[1] Sex and race
BYTE[1] Strength
BYTE[1] Dexterity
BYTE[1] Intelligence
BYTE[6] Three skills (id, value)
BYTE[2] Skin hue
BYTE[2] Hair style
BYTE[2] Hair hue
BYTE[2] Beard style
BYTE[2] Beard hue
BYTE[1] Unknown (0)
BYTE[1] Starting city
BYTE[4] Slot
BYTE[4] Client IP (0)
BYTE[2] Shirt hue
BYTE[2] Pants hue
*/
export function createCharacter(creation: Creation): Buffer {
  if (!/^[A-Za-z][A-Za-z .'-]{1,15}$/.test(creation.name))
    throw new Error('Character names must be 2-16 supported ASCII letters/punctuation');
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
