import { expect, test } from 'bun:test';

import { activityLine, intentOf } from '../src/conversation';
import type { Checkpoint } from '../src/store';

test('player lines map to supported intents', () => {
  expect(intentOf('hail there')).toBe('greet');
  expect(intentOf('Where is the bank?')).toBe('where');
  expect(intentOf("where's the healer")).toBe('where');
  expect(intentOf('what are you doing')).toBe('doing');
  expect(intentOf('can you help me')).toBe('help');
  expect(intentOf('follow me please')).toBe('follow');
  expect(intentOf('farewell')).toBe('bye');
  expect(intentOf('vendor buy')).toBeUndefined();
  expect(intentOf('and you?')).toBe('doing');
  expect(intentOf('what?')).toBe('clarify');
  expect(intentOf('What brings thee here, Martin?')).toBe('doing');
  expect(intentOf('And thou?')).toBe('doing');
  expect(intentOf('stop')).toBe('wait');
  expect(intentOf('stop talking')).toBe('bye');
  expect(intentOf('wtb boards')).toBe('trade');
});

test('activity lines come from the persisted goal, not invention', () => {
  const at = (phase: string, ground?: string): Checkpoint => ({
    goal: { kind: 'x', phase },
    memories: [],
    relationships: {},
    ...(ground ? { hunting: { loot: [], killsSinceBank: 0, pending: 'hunt', ground } } : {})
  });
  expect(activityLine(at('patrolling', 'Yew'))).toBe('I hunt the undead at the Yew cemetery.');
  expect(activityLine(at('fighting'))).toBe('I am too busy fighting to talk!');
  expect(activityLine(at('mining'))).toContain('mines');
  expect(activityLine(at('bank-travel'))).toBe('I am off to the bank.');
});

test('a rephrasing keeps every number and name, adds none, and makes no new promise', async () => {
  const { acceptable } = await import('../src/phrasing');
  const directions = 'The bank? Thou shouldst find it about 30 paces north, near First Bank Of Britain.';
  expect(acceptable(directions, 'Seek the bank some 30 paces north, by First Bank Of Britain.')).toBe(true);
  expect(acceptable(directions, 'The bank lies about 40 paces north, near First Bank Of Britain.')).toBe(false);
  expect(acceptable(directions, 'The bank is 30 paces north, near Lord British.')).toBe(false);
  expect(acceptable(directions, 'The first bank is about 30 paces north.')).toBe(false);
  expect(acceptable('Hail, Oscar Holt.', 'Well met, Oscar Holt!')).toBe(true);
  expect(acceptable('Hail, Oscar Holt.', 'Hail to thee, Oscar.')).toBe(true);
  expect(acceptable('I cannot leave my work, Oscar.', "Fine, Oscar, I'll follow thee.")).toBe(false);
  expect(acceptable('Fare thee well.', '"Fare thee well."\n*waves*')).toBe(false);
});
