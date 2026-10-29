import { expect, test } from 'bun:test';

import type { Command } from '@gemwright/network/commands';

import { ActionArbiter } from '../src/action-arbiter';
import { ActionBusy, ActionInterrupted, ActionTimeout } from '../src/action-errors';

const command = (overrides: Partial<Command> = {}): Command => ({
  name: 'moveItem',
  args: [],
  resources: ['hands', 'inventory'],
  async: true,
  atomic: true,
  confirmed: true,
  ...overrides
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('safety preempts a sleeping routine and rejects its stale continuation', async () => {
  const arbiter = new ActionArbiter();
  const sleeping = deferred();
  const resumed = deferred();
  let sent = 0;
  let stale: unknown;
  const work = arbiter
    .run('work', 'craft', async () => {
      await sleeping.promise;
      try {
        arbiter.execute(command({ async: false }), () => sent++);
      } catch (error) {
        stale = error;
      }
      resumed.resolve();
    })
    .catch((error) => error);
  arbiter.interruptBelow('escape', new ActionInterrupted('attacked'));
  expect(await work).toBeInstanceOf(ActionInterrupted);
  await arbiter.run('escape', 'leave', async () => {
    arbiter.execute(command({ async: false }), () => sent++);
  });
  sleeping.resolve();
  await resumed.promise;
  expect(stale).toBeInstanceOf(ActionInterrupted);
  expect(sent).toBe(1);
});

test('an in-flight transfer retains ownership through preemption, without replay', async () => {
  const arbiter = new ActionArbiter();
  const acknowledgement = deferred();
  const sent: string[] = [];
  const work = arbiter
    .run('work', 'bank', async () => {
      await arbiter.execute(command(), async () => {
        sent.push('deposit');
        await acknowledgement.promise;
      });
    })
    .catch((error) => error);
  await Bun.sleep(0);
  const safety = arbiter.run('escape', 'escape', async () => {
    await arbiter.execute(command({ name: 'walk', resources: ['hands', 'movement'] }), async () => {
      sent.push('walk');
    });
  });
  await Bun.sleep(10);
  expect(sent).toEqual(['deposit']);
  acknowledgement.resolve();
  await safety;
  expect(await work).toBeInstanceOf(ActionInterrupted);
  expect(sent).toEqual(['deposit', 'walk']);
  expect(arbiter.history.filter((event) => event.command === 'moveItem' && event.stage === 'completed')).toHaveLength(
    1
  );
});

test('concurrent commands inside one scope serialize; sync conflicts do not dispatch', async () => {
  const arbiter = new ActionArbiter();
  const acknowledgement = deferred();
  const sent: number[] = [];
  await arbiter.run('work', 'inventory', async () => {
    const first = arbiter.execute(command(), async () => {
      sent.push(1);
      await acknowledgement.promise;
    });
    expect(() => arbiter.execute(command({ async: false }), () => sent.push(99))).toThrow(ActionBusy);
    const second = arbiter.execute(command(), async () => {
      sent.push(2);
    });
    expect(sent).toEqual([1]);
    acknowledgement.resolve();
    await Promise.all([first, second]);
  });
  expect(sent).toEqual([1, 2]);
});

test('deadlines terminate waiting work and allow a fresh action', async () => {
  const arbiter = new ActionArbiter();
  const forever = deferred();
  await expect(arbiter.run('work', 'stuck', () => forever.promise, 15)).rejects.toBeInstanceOf(ActionTimeout);
  await arbiter.run('work', 'fresh', async () => {
    expect(arbiter.current()?.intent).toBe('fresh');
  });
  expect(arbiter.history.some((event) => event.intent === 'stuck' && event.stage === 'timed-out')).toBe(true);
});

test('nested combat survives trade preemption; escape preempts combat', async () => {
  const arbiter = new ActionArbiter();
  const done = deferred();
  const work = arbiter
    .run('work', 'hunt', () => arbiter.run('combat', 'fight', () => done.promise))
    .catch((error) => error);
  arbiter.interruptBelow('trade', new ActionInterrupted('trade'));
  expect(arbiter.history.some((event) => event.stage === 'interrupted')).toBe(false);
  arbiter.interruptBelow('escape', new ActionInterrupted('danger'));
  expect(await work).toBeInstanceOf(ActionInterrupted);
  done.resolve();
});

test('session arbiters are isolated and detached work has its own authority', async () => {
  const a = new ActionArbiter();
  const b = new ActionArbiter();
  const done = deferred();
  const work = a.run('work', 'first', async () => {
    await b.run('trade', 'second resident', async () => {
      expect(a.current()?.kind).toBeUndefined();
      expect(b.current()?.kind).toBe('trade');
    });
    await a.run(
      'trade',
      'background',
      async () => {
        expect(a.current()?.parent).toBeUndefined();
      },
      100,
      true
    );
    await done.promise;
  });
  done.resolve();
  await work;
  a.close();
  await b.run('work', 'unaffected', async () => {});
});

test('failed commands release operation locks and report unconfirmed sends honestly', async () => {
  const arbiter = new ActionArbiter();
  await expect(
    arbiter.run('work', 'failed', async () => {
      await arbiter.execute(command(), async () => {
        throw new Error('refused');
      });
    })
  ).rejects.toThrow('refused');
  await arbiter.run('trade', 'request', async () => {
    arbiter.execute(command({ name: 'acceptTrade', async: false, atomic: false, confirmed: false }), () => {});
  });
  expect(arbiter.history.some((event) => event.command === 'acceptTrade' && event.stage === 'unconfirmed')).toBe(true);
});

test('an observed refusal is a failure, not a claimed successful outcome', async () => {
  const arbiter = new ActionArbiter();
  expect(
    await arbiter.run('work', 'blocked walk', async () => arbiter.execute(command({ name: 'walk' }), async () => false))
  ).toBe(false);
  expect(arbiter.history.some((event) => event.command === 'walk' && event.stage === 'failed')).toBe(true);
  expect(arbiter.history.some((event) => !event.command && event.stage === 'failed')).toBe(true);
});
