import { expect, test } from 'bun:test';

import { localDecision } from '../src/decision-local';

test('local decisions keep the preferred legal action and replace it when it becomes invalid', () => {
  let ready = true;
  const candidates = [
    { id: 'retreat', description: 'Return to refuge', valid: () => true },
    { id: 'retrieve', description: 'Recover belongings', valid: () => ready }
  ];
  expect(localDecision(candidates, 'retrieve').baseline.id).toBe('retrieve');
  ready = false;
  const pick = localDecision(candidates, 'retrieve');
  expect(pick.baseline.id).toBe('retreat');
  expect(pick.candidates.map((candidate) => candidate.id)).toEqual(['retreat']);
});

test('local decisions reject missing or ambiguous legal candidates', () => {
  const candidate = { id: 'retreat', description: 'Return to refuge', valid: () => true };
  expect(() => localDecision([], 'retreat')).toThrow('Invalid decision candidates');
  expect(() => localDecision([{ ...candidate, valid: () => false }], 'retreat')).toThrow('Invalid decision candidates');
  expect(() => localDecision([candidate, candidate], 'retreat')).toThrow('Invalid decision candidates');
});
