import { expect, test } from 'bun:test';

import { useSkill } from '../src/packets';

test('Wraith Form uses the ServUO Necromancy spell id in the cast command', () => {
  const packet = useSkill(116, true);
  expect(packet[0]).toBe(0x12);
  expect(packet.subarray(3).toString('latin1')).toBe('\x56116\0');
  for (const invalid of [0, 65, 100, 118, 116.5]) expect(() => useSkill(invalid, true)).toThrow();
  expect(() => useSkill(116)).toThrow();
});
