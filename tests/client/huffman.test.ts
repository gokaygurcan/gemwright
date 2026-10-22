import { expect, test } from 'bun:test';

import { Huffman } from '../../client/huffman';

// Encoded using Sphere's CHuffman compression table, including its end-of-packet marker.
const vectors = [
  ['7301', '76fe80'],
  ['73017301', '76fe8076fe80'],
  ['48656c6c6f2c20554f21', '43f96a6af171b511ebc368'],
  ['00'.repeat(32), '0000000000000000d0']
] as const;
test('decodes actual Sphere vectors across every TCP split boundary', () => {
  for (const [plain, packed] of vectors) {
    const bytes = Buffer.from(packed, 'hex');
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new Huffman();
      expect(
        Buffer.concat([decoder.decompress(bytes.subarray(0, split)), decoder.decompress(bytes.subarray(split))])
      ).toEqual(Buffer.from(plain, 'hex'));
    }
  }
});
test('bounds decoded output', () => {
  const decoder = new Huffman();
  expect(() => decoder.decompress(Buffer.from(vectors[3][1], 'hex'), 8)).toThrow('maxOut');
});

test('reuses caller storage while preserving split-symbol decoding and output bounds', () => {
  const bytes = Buffer.from(vectors[2][1], 'hex');
  const storage = Buffer.alloc(65536);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new Huffman();
    const first = Buffer.from(decoder.decompress(bytes.subarray(0, split), storage.length, storage));
    const second = decoder.decompress(bytes.subarray(split), storage.length, storage);
    expect(Buffer.concat([first, second])).toEqual(Buffer.from(vectors[2][0], 'hex'));
  }
  expect(() => new Huffman().decompress(bytes, 32, Buffer.alloc(8))).toThrow('smaller');
});
