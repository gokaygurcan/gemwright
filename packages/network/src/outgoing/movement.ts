/*
Move Request
Client steps one tile; the server answers with Move Acknowledge or Move Reject.

Size: 7 bytes

Packet Build
BYTE[1] Packet identifier
BYTE[1] Direction (| 0x80 to run)
BYTE[1] Sequence number
BYTE[4] Fast-walk key (0)
*/
export function walk(direction: number, sequence: number, running = false): Buffer {
  if (!Number.isInteger(direction) || direction < 0 || direction > 7) throw new Error('Direction must be 0-7');
  return Buffer.from([0x02, direction | (running ? 0x80 : 0), sequence, 0, 0, 0, 0]);
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
