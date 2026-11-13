import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { setDebug } from '../src/debug';
import { describe, Narrator } from '../src/v2/narrate';

// A staff member says STOP: it holds until CONTINUE, answers STATUS with what it is doing, and ignores
// the same words from a player.
test('staff commands stop, resume and ask a resident', () => {
  const said: string[] = [];
  const world = {
    journal: [] as { serial: number; text: string }[],
    entities: new Map([
      [7, { serial: 7, notoriety: 7 }],
      [8, { serial: 8, notoriety: 1 }]
    ])
  };
  const session = {
    world,
    phase: 'ready',
    say: (t: string) => said.push(t),
    emote: () => {}
  } as unknown as PlayerSession;
  const narrator = new Narrator(session);
  narrator.tell('using Pickaxe on land241 at 5,5');
  world.journal.push({ serial: 8, text: 'GEMWRIGHT::STOP' });
  expect(narrator.listen()).toBe(false);
  world.journal.push({ serial: 7, text: 'GEMWRIGHT::STOP' }, { serial: 7, text: 'gemwright::status' });
  expect(narrator.listen()).toBe(true);
  expect(said).toEqual(['using Pickaxe on land241 at 5,5 (stopped)']);
  world.journal.push({ serial: 7, text: 'GEMWRIGHT::CONTINUE' });
  expect(narrator.listen()).toBe(false);
});

// With debugging on, each change of what it does is said over its head, once.
test('it emotes each change of what it does when debugging', () => {
  setDebug(true);
  const emoted: string[] = [];
  const session = {
    world: { journal: [] },
    phase: 'ready',
    emote: (t: string) => emoted.push(t)
  } as unknown as PlayerSession;
  const narrator = new Narrator(session);
  const doing = describe('go 100,200: attack Mongbat/StrongMongbat', []);
  narrator.tell(doing);
  narrator.tell(doing);
  narrator.tell('looking for different work');
  setDebug(false);
  expect(emoted).toEqual(['traveling to 100,200: fighting Mongbat', 'looking for different work']);
});
