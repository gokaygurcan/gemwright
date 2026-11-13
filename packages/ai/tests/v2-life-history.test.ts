import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { History } from '../src/v2/history';
import * as living from '../src/v2/live';
import { act } from '../src/v2/shadow';

for (const failed of [false, true]) {
  test(`life history persists ${failed ? 'failure' : 'normal termination'} without hiding errors`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemwright-life-'));
    const history = new History(join(directory, 'history.sqlite'));
    const world = new WorldView();
    world.serial = 1;
    world.position = { x: 100, y: 100, z: 0, direction: 0 };
    const session = { world, phase: 'ready' } as unknown as PlayerSession;
    const live = spyOn(living, 'live').mockImplementation(async () => {
      if (failed) throw new Error('lost connection');
    });
    try {
      const run = act(session, 'finn', history, () => !failed, ['Mining']);
      if (failed) await expect(run).rejects.toThrow('lost connection');
      else await run;
      expect(history.read('finn', 'life-started')).toEqual([
        { trade: ['Mining'], goal: 'Gain wealth and trade skills while surviving' }
      ]);
      expect(history.read('finn', 'life-ended')).toEqual([
        expect.objectContaining({
          phase: 'ready',
          reason: failed ? 'failed' : 'stopped',
          ...(failed ? { failure: 'lost connection' } : {})
        })
      ]);
    } finally {
      live.mockRestore();
      history.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
