export interface TargetCursor {
  id: number;
  ground: boolean;
  flags: number;
  // The house a multi-target cursor (0x99) places.
  multi?: number;
  // When the shard put it up (ms), to tell an abandoned cursor from one being answered.
  at?: number;
}

export interface TargetLocation {
  serial: number;
  x: number;
  y: number;
  z: number;
  graphic: number;
}

/*
Target Response
Client answers a target cursor (0x6C) with an object or a tile, or cancels it.

Size: 19 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[1] Type (0 object, 1 ground)
BYTE[4] Cursor id
BYTE[1] Flags (as the cursor asked)
BYTE[4] Target serial
BYTE[2] X (0xFFFF to cancel)
BYTE[2] Y (0xFFFF to cancel)
BYTE[2] Z
BYTE[2] Graphic
*/
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
