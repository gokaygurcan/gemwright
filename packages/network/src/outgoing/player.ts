import { variable } from './encode';

/*
War Mode
Client switches between war and peace.

Size: 5 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[1] Flag (0 peace, 1 war)
BYTE[3] Unknown (0x00 0x32 0x00)
*/
export function warMode(enabled: boolean): Buffer {
  return Buffer.from([0x72, Number(enabled), 0, 0x32, 0]);
}

/*
Skill Lock Change
Client sets one skill to rise, fall or stay locked.

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[2] Skill id
BYTE[1] Lock (0 up, 1 down, 2 locked)
*/
export function skillLock(skill: number, lock: number): Buffer {
  if (!Number.isInteger(skill) || skill < 0 || skill > 57 || ![0, 1, 2].includes(lock))
    throw new Error('Invalid skill lock');
  const body = Buffer.alloc(3);
  body.writeUInt16BE(skill, 0);
  body[2] = lock;
  return variable(0x3a, body);
}

/*
Request Skill / Spell Use
Client uses a skill (type 0x24, "<id> 0") or casts a spell from the carried book (type 0x56, "<id>").

Size: Variable

Packet Build
BYTE[1] Packet identifier
BYTE[2] Length
BYTE[1] Type
BYTE[n] Command (ASCII, null-terminated)
*/
export function useSkill(id: number, spell = false): Buffer {
  if (!Number.isInteger(id) || id < (spell ? 1 : 0) || id > (spell ? 64 : 57)) throw new Error('Invalid skill id');
  return variable(0x12, Buffer.from(spell ? `\x56${id}\0` : `\x24${id} 0\0`, 'latin1'));
}
