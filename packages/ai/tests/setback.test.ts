import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { Blocked } from '../src/blocked';
import { passSetback } from '../src/setback';
import { behaviorFixture } from './behavior-fixture';

function context(f: ReturnType<typeof behaviorFixture>, check: () => void, session = f.session) {
  const logged: string[] = [];
  return {
    logged,
    ctx: {
      session: session as unknown as PlayerSession,
      check,
      phase: () => {},
      log: (message: string) => logged.push(message),
      deadline: Date.now() + 60_000,
      items: () => [],
      checkpoint: f.checkpoint
    }
  };
}

test('a goal-level interruption during a setback ends the wait, not the run', async () => {
  const f = behaviorFixture();
  const { ctx, logged } = context(f, () => {
    throw new Blocked('stuck', 'Going in circles (the same steps three times with nothing gained)');
  });
  await passSetback(ctx, 'Repeatedly blocked: No public moongate can be reached on the island');
  expect(logged.some((line) => line.startsWith('Setback interrupted:'))).toBe(true);
});

test('a session-level failure during a setback still travels to the supervisor', async () => {
  const f = behaviorFixture();
  const broken = { ...f.session, phase: 'disconnected' } as unknown as PlayerSession;
  const { ctx } = context(
    f,
    () => {
      throw new Blocked('stuck', 'Going in circles');
    },
    broken
  );
  expect(passSetback(ctx, 'Repeatedly blocked: something else')).rejects.toThrow('Going in circles');
});
