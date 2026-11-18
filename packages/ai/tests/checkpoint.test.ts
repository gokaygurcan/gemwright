import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { History } from '../src/history';
import { Mind } from '../src/mind';
import { traitsOf } from '../src/traits';

test('persisted checkpoints retain maps and replay only the subsequent history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-checkpoint-'));
  const history = new History(join(dir, 'history.sqlite'));
  try {
    const make = () => new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
    const mind = make();
    const first = { resident: 'r', at: 0, kind: 'executed', data: { id: 'attack 20', succeeded: false } };
    history.record(first);
    mind.observe(first);
    const through = history.latest();
    history.saveCheckpoint('r', 'version1', through, mind.snapshot());
    history.record({
      resident: 'r',
      at: 1,
      kind: 'movement',
      data: { key: 'foot run', steps: 1, seconds: 0.2, stamina: 0 }
    });
    const saved = history.checkpoint<ReturnType<Mind['snapshot']>>('r', 'version1');
    expect(saved?.through).toBe(through);
    if (!saved) throw new Error('Checkpoint was not saved');
    const resumed = make();
    resumed.restore(saved.state);
    const tail = [...history.lived('r', history.latest(), [], saved.through)];
    expect(tail.map((e) => e.kind)).toEqual(['movement']);
    for (const event of tail) resumed.observe(event);
    expect(resumed.chance('attack 20')).toBe(0.5);
    expect(resumed.locomotion.experience('foot run')?.steps).toBe(1);
    expect(history.checkpoint('r', 'version2')).toBeUndefined();
    expect([...history.lived('r', history.latest(), [])]).toHaveLength(2);
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpointing an unfinished harvest preserves its learned outcome after continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-checkpoint-'));
  const history = new History(join(dir, 'history.sqlite'));
  try {
    const make = () => new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
    const full = make();
    const record = (at: number, kind: string, data: object) => {
      const event = { resident: 'r', at, kind, data };
      history.record(event);
      full.observe(event);
    };
    record(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } } });
    record(0, 'gained', { serial: 10, kind: 'item', graphic: 3718, is: ['Pickaxe'] });
    record(1000, 'acted', { verb: 'double-click', serial: 10 });
    record(1100, 'acted', { verb: 'target', serial: 0, graphic: 1 });
    record(1900, 'gained', { serial: 20, kind: 'item', graphic: 6585, amount: 2, is: ['IronOre'] });
    record(2000, 'acted', { verb: 'walk' });
    record(3000, 'acted', { verb: 'double-click', serial: 10 });
    record(3100, 'acted', { verb: 'target', serial: 0, graphic: 1 });
    const through = history.latest();
    history.saveCheckpoint('r', 'v1', through, full.snapshot());
    record(3900, 'gained', { serial: 21, kind: 'item', graphic: 6585, amount: 2, is: ['IronOre'] });
    record(4000, 'acted', { verb: 'walk' });
    const saved = history.checkpoint<ReturnType<Mind['snapshot']>>('r', 'v1');
    if (!saved) throw new Error('Checkpoint was not saved');
    const resumed = make();
    resumed.restore(saved.state);
    for (const event of history.lived('r', history.latest(), [], saved.through)) resumed.observe(event);
    expect(resumed.snapshot()).toEqual(full.snapshot());
    expect(resumed.appraise('double-click my Pickaxe > target tile1')?.outcome?.gained).toEqual({ IronOre: 2 });
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('known bank supplies survive closing history, restoring a checkpoint and logging in again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bank-restart-'));
  const path = join(dir, 'history.sqlite');
  let history = new History(path);
  try {
    const make = () => new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
    const mind = make();
    for (const [at, kind, data] of [
      [0, 'awake', { serial: 1, self: {}, skills: { Mining: 100 } }],
      [1, 'revealed', { serial: 5, kind: 'item', layer: 29, parent: 1, is: ['BankBox'] }],
      [2, 'revealed', { serial: 10, kind: 'item', parent: 5, amount: 43, is: ['IronIngot'] }]
    ] as const) {
      const event = { resident: 'r', at, kind, data };
      history.record(event);
      mind.observe(event);
    }
    mind.complete('harvest 20', false);
    history.saveCheckpoint('r', 'bank-restart', history.latest(), mind.snapshot());
    history.close();
    history = new History(path);
    const resumed = make();
    const saved = history.checkpoint<ReturnType<Mind['snapshot']>>('r', 'bank-restart');
    if (!saved) throw new Error('Missing persisted checkpoint');
    resumed.restore(saved.state);
    resumed.observe({ resident: 'r', at: 3, kind: 'awake', data: { serial: 1, self: {}, skills: {} } });
    expect(resumed.belongings().get(10)).toEqual({ name: 'IronIngot', amount: 43 });
    expect(resumed.banked(10)).toBe(true);
    expect(resumed.skill('Mining')).toBe(100);
    expect(resumed.chance('harvest 20')).toBe(0.5);
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
