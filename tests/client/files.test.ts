import { expect, test } from 'bun:test';

import { parseManifest, runtimeFiles } from '../../client/files';

const file = { path: 'art.mul', bytes: 12, sha256: 'a'.repeat(64) };
test('rejects asset paths that escape the cache namespace and case collisions', () => {
  expect(parseManifest({ files: [file] })).toEqual([file]);
  for (const path of ['../secret', '/art.mul', 'music//config.txt', '.env', 'file\\name.mul'])
    expect(() => parseManifest({ files: [{ ...file, path }] })).toThrow('invalid');
  expect(() => parseManifest({ files: [file, { ...file, path: 'ART.MUL' }] })).toThrow('Duplicate');
  for (const bytes of [-1, 1.5, NaN, '12', undefined])
    expect(() => parseManifest({ files: [{ ...file, bytes }] })).toThrow('invalid');
  for (const sha256 of ['bad', ['a'.repeat(64)], null])
    expect(() => parseManifest({ files: [{ ...file, sha256 }] })).toThrow('invalid');
});
test('leaves the optional broken dictionary and streamed media out of memory and refuses files beyond the runtime address limit', () => {
  const streamed = ['music/digital/stones.mp3', 'music/stones.mid', 'MapsCache/map0.png', 'STRING_DICTIONARY.UOP'].map(
    (path) => ({
      ...file,
      path
    })
  );
  expect(runtimeFiles([file, ...streamed])).toEqual([file]);
  expect(() => runtimeFiles([{ ...file, bytes: 2 * 1024 ** 3 }])).toThrow('per-file limit');
});
