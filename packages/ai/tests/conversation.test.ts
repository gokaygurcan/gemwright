import { expect, test } from 'bun:test';

import { intentOf } from '../src/conversation';
import { activityLine, planLine } from '../src/conversation-facts';
import { replyOptions, threadFor } from '../src/dialogue';
import { type Identity, identityFrom } from '../src/identity';
import { needsLine } from '../src/needs';
import { replyRejection } from '../src/respond';
import type { Checkpoint } from '../src/store';

// The shard's context menu for the speaker is the fingerprint (identity.ts): business entries mean
// an NPC to trade with, party entries mean a person. Notoriety and names decide nothing.
test('the context menu entries tell an NPC from a player', () => {
  const menu = (...clilocs: number[]) => clilocs.map((cliloc) => ({ cliloc }));
  expect(identityFrom(menu(3006103))).toBe<Identity>('npc'); // Buy
  expect(identityFrom(menu(3002133, 3006104))).toBe<Identity>('npc'); // Paperdoll + Sell
  expect(identityFrom(menu(3006152))).toBe<Identity>('npc'); // Bulk Order Info
  expect(identityFrom(menu(1152294))).toBe<Identity>('npc'); // Bribe
  expect(identityFrom(menu(3002133, 3000197))).toBe<Identity>('player'); // Paperdoll + Add Party
  expect(identityFrom(menu(3000198))).toBe<Identity>('player'); // Remove From Party
  // A vendor that also offers party entries is still a vendor: business decides first.
  expect(identityFrom(menu(3006103, 3000197))).toBe<Identity>('npc');
  expect(identityFrom(menu(3002133))).toBe<Identity>('unknown'); // paperdoll alone tells nothing
});

test('patience runs out on small-talk repeats, and a name still gets a word', async () => {
  const { patienceFor } = await import('../src/engagement');
  const session = {} as never; // only a WeakMap key
  const chat = (named = false) => ({ named, intent: 'greet' });
  const t0 = Date.now();
  expect(patienceFor(session, 1, 'hello there', chat(), t0).verdict).toBe('ok');
  expect(patienceFor(session, 1, 'hello there!', chat(), t0 + 1000).verdict).toBe('ok');
  const third = patienceFor(session, 1, 'Hello  there', chat(), t0 + 2000);
  expect(third.verdict).toBe('decline');
  expect(third.say).toContain('said that already');
  // Bored: repeats are silenced without a word; a fresh line naming the resident gets one word a minute.
  expect(patienceFor(session, 1, 'hello there', chat(), t0 + 3000).verdict).toBe('decline');
  expect(patienceFor(session, 1, 'hello there', chat(true), t0 + 3500).verdict).toBe('decline');
  expect(patienceFor(session, 1, 'are you there, friend?', chat(true), t0 + 4000).verdict).toBe('brief');
  expect(patienceFor(session, 1, 'anyone home?', chat(true), t0 + 5000).verdict).toBe('decline');
  // Another talker is unaffected, and the boredom lifts after its window.
  expect(patienceFor(session, 2, 'hail', chat(), t0 + 6000).verdict).toBe('ok');
  expect(patienceFor(session, 1, 'hail', chat(), t0 + 11 * 60_000).verdict).toBe('ok');
});

test('a stream of small talk from one talker also ends the conversation', async () => {
  const { patienceFor } = await import('../src/engagement');
  const session = {} as never;
  const t0 = Date.now();
  for (let n = 0; n < 5; n++)
    expect(
      patienceFor(session, 9, `line number ${n}`, { named: false, intent: 'chatter' }, t0 + n * 1000).verdict
    ).toBe('ok');
  const sixth = patienceFor(session, 9, 'line number five', { named: false, intent: 'chatter' }, t0 + 6000);
  expect(sixth.verdict).toBe('decline');
  expect(sixth.say).toBeDefined();
});

// A player may need the same answer twice (a dropped reply, a real need): requests are answered
// until the same one is put five times, and only then does the resident say so and pause.
test('requests do not bore a resident the way small talk does', async () => {
  const { patienceFor } = await import('../src/engagement');
  const session = {} as never;
  const ask = { named: false, intent: 'where' };
  const t0 = Date.now();
  for (let n = 0; n < 4; n++)
    expect(patienceFor(session, 7, 'where is the bank?', ask, t0 + n * 1000).verdict).toBe('ok');
  const fifth = patienceFor(session, 7, 'where is the bank?', ask, t0 + 4000);
  expect(fifth.verdict).toBe('decline');
  expect(fifth.say).toContain('told thee');
  // A real request still gets a word in passing while bored; idle small talk does not.
  expect(patienceFor(session, 7, 'and where is the forge?', ask, t0 + 70_000).verdict).toBe('brief');
  expect(patienceFor(session, 7, 'nice weather', { named: false, intent: 'chatter' }, t0 + 71_000).verdict).toBe(
    'decline'
  );
});

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
