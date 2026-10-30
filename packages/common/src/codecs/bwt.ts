// The client's BWT stage after zlib (UOP compression flag 3), ported from ClassicUO's
// BwtDecompress: a move-to-front decode of the bytes after a 4-byte header, then an inverse
// Burrows-Wheeler transform whose first 1024 bytes are the 256 symbol counts.
export function bwtDecompress(buffer: Uint8Array): Uint8Array {
  const table = Array.from({ length: 256 }, (_, i) => i);
  const list = new Uint8Array(buffer.length - 4);
  // ClassicUO reads one byte ahead, so the last byte is never decoded.
  for (let at = 4, count = 0; at < buffer.length - 1; at++) {
    let current = buffer[at] ?? 0;
    const value = table[current] ?? 0;
    for (; current > 0; current--) table[current] = table[current - 1] ?? 0;
    table[0] = value;
    list[count++] = value;
  }
  return inverse(list);
}

function inverse(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const partial = new Int32Array(768);
  for (let i = 0; i < 256; i++) partial[i] = view.getInt32(i * 4, true);
  let length = 0;
  for (let i = 0; i < 256; i++) length += partial[i] ?? 0;
  const output = new Uint8Array(length);
  const symbols = Array.from({ length: 256 }, (_, i) => i);
  let nonZero = 0;
  for (let i = 0; i < 256; i++) if (partial[i]) nonZero++;
  // Symbols by descending count.
  const order = [...Array(256).keys()]
    .filter((i) => partial[i])
    .sort((a, b) => (partial[b] ?? 0) - (partial[a] ?? 0) || a - b);
  for (let i = 0, m = 0; i < nonZero; i++) {
    const symbol = order[i] ?? 0;
    symbols[input[m + 1024] ?? 0] = symbol;
    partial[symbol + 256] = m + 1;
    m += partial[symbol] ?? 0;
    partial[symbol + 512] = m;
  }
  const shift = (max: number) => {
    for (let i = 0; i < max; i++) symbols[i] = symbols[i + 1] ?? 0;
  };
  let value = symbols[0] ?? 0;
  for (let count = 0; count < length; count++) {
    output[count] = value;
    const first = partial[value + 256] ?? 0;
    if (first >= (partial[value + 512] ?? 0)) {
      if (nonZero-- > 0) {
        shift(nonZero);
        value = symbols[0] ?? 0;
      }
    } else {
      const index = input[first + 1024] ?? 0;
      partial[value + 256] = first + 1;
      if (index !== 0) {
        shift(index);
        symbols[index] = value;
        value = symbols[0] ?? 0;
      }
    }
  }
  return output;
}
