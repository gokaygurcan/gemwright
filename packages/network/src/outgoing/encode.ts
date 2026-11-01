export function ascii(value: string, maxBytes: number, label: string): Buffer {
  if (!value || !/^[\x20-\x7e]+$/.test(value) || Buffer.byteLength(value) >= maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes - 1} printable ASCII characters`);
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
