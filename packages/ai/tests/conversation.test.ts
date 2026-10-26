import { expect, test } from 'bun:test';

import { intentOf } from '../src/conversation';
import { activityLine, planLine } from '../src/conversation-facts';
import { replyOptions, threadFor } from '../src/dialogue';
import { needsLine } from '../src/needs';
import { replyRejection } from '../src/respond';
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

test('players asking where a resident goes or what it needs always get a spoken answer', () => {
  expect(intentOf('where are you going?')).toBe('plans');
  expect(intentOf('whither, friend?')).toBe('plans');
  expect(intentOf('do you need anything?')).toBe('needs');
  expect(intentOf('need some gold?')).toBe('needs');
  expect(intentOf('can i give you something')).toBe('needs');
  const plans: Checkpoint = {
    goal: { kind: 'hunting', phase: 'travelling-to-graveyard', note: 'Heading to the orc spawn near 634,1462' },
    memories: [],
    relationships: {}
  };
  expect(planLine(plans)).toBe('I am heading to the orc spawn.');
  const thread = threadFor(new Map(), 1, 'Testing Test', false);
  const facts = { name: 'Testing Test', activity: 'Just going about my business.', warm: false };
  // Nothing understood, nothing to trade, nothing known: a player still hears something.
  for (const intent of ['chatter', 'trade', 'where', 'clarify'] as const) {
    const { options, baseline } = replyOptions(intent, thread, facts);
    expect(options.find((option) => option.id === baseline)?.text).toBeTruthy();
  }
  // A fellow resident's small talk may still go unanswered.
  const peer = threadFor(new Map(), 2, 'Jasper', true);
  expect(replyOptions('chatter', peer, facts).baseline).toBe('stay-quiet');
  expect(needsLine([])).toContain('well supplied');
  expect(needsLine([{ what: 'bandages', why: 'to bind my wounds' }])).toBe('I could use bandages; to bind my wounds.');
});

test("Haiku's answers keep to the resident's facts", () => {
  const facts = {
    me: 'Martin Ash',
    profession: 'fisherman',
    home: 'Britain',
    doing: 'Fishing, and mostly waiting for a bite.',
    goingTo: 'I am walking to the water.',
    needs: ['a fishing pole: I cannot work without one'],
    carriedGold: 12,
    bestSkills: ['Fishing 61.2']
  };
  expect(replyRejection('I could use a fishing pole, friend.', facts, 'need anything?')).toBeUndefined();
  expect(replyRejection('I have 500 gold in Minoc.', facts, 'rich?')).toBe('added the number 500');
  expect(replyRejection('Ask Lord Blackthorn, he knows.', facts, 'who knows?')).toContain('added the name');
  expect(replyRejection("I'll fetch it for thee tomorrow.", facts, 'can you?')).toBe('made a promise');
});
