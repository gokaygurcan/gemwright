import { expect, spyOn, test } from 'bun:test';

import type { Entity } from '@gemwright/network/world';

import { play, playable } from '../src/bard';
import type { ProfessionContext } from '../src/profession';
import { behaviorFixture } from './behavior-fixture';

// A lone undead already in discord answers every song with "Your target is already in discord"
// (ServUO Discordance.cs): the bard played at it every six seconds all day for no gain.
test('a target the shard says is already in discord is not played at again', async () => {
  let clock = Date.now();
  const spies = [
    spyOn(Date, 'now').mockImplementation(() => clock),
    spyOn(Bun, 'sleep').mockImplementation(async (ms) => {
      clock += Number(ms);
    })
  ];
  try {
    const f = behaviorFixture('bard');
    const lute = { serial: 20, kind: 'item' as const, graphic: 0xeb3, parent: 10 };
    f.world.entities.set(20, lute);
    const undead: Entity = {
      serial: 50,
      kind: 'mobile',
      graphic: 0x3,
      notoriety: 3,
      position: { x: 103, y: 100, z: 0, direction: 0 }
    };
    f.world.entities.set(50, undead);
    f.session.useSkill = () => {
      f.world.target = { id: 1, ground: false, flags: 1 };
    };
    f.session.waitFor = async (predicate: () => boolean) => {
      if (!predicate()) throw new Error('No cursor');
    };
    f.session.target = (target) => {
      f.world.target = null;
      if (target?.serial === 50) f.world.journal.push({ cliloc: 1049537 } as (typeof f.world.journal)[number]);
    };
    const ctx = {
      ...f.ctx,
      serial: 1,
      carried: () => [lute]
    } as unknown as ProfessionContext;
    expect(playable(ctx, undead)).toBe(true);
    expect(await play(ctx, 'Discordance', [undead])).toBe(false);
    expect(playable(ctx, undead)).toBe(false);
    clock += 61_000;
    expect(playable(ctx, undead)).toBe(true);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test('a pair the shard says cannot be provoked is not set on each other again', async () => {
  let clock = Date.now();
  const spies = [
    spyOn(Date, 'now').mockImplementation(() => clock),
    spyOn(Bun, 'sleep').mockImplementation(async (ms) => {
      clock += Number(ms);
    })
  ];
  try {
    const f = behaviorFixture('bard');
    const lute = { serial: 20, kind: 'item' as const, graphic: 0xeb3, parent: 10 };
    f.world.entities.set(20, lute);
    const a: Entity = {
      serial: 50,
      kind: 'mobile',
      graphic: 0x3,
      notoriety: 3,
      position: { x: 103, y: 100, z: 0, direction: 0 }
    };
    const b: Entity = {
      serial: 51,
      kind: 'mobile',
      graphic: 0x3,
      notoriety: 3,
      position: { x: 104, y: 100, z: 0, direction: 0 }
    };
    f.world.entities.set(50, a);
    f.world.entities.set(51, b);
    f.session.useSkill = () => {
      f.world.target = { id: 1, ground: false, flags: 1 };
    };
    f.session.waitFor = async (predicate: () => boolean) => {
      if (!predicate()) throw new Error('No cursor');
    };
    let picks = 0;
    f.session.target = () => {
      f.world.target = ++picks === 1 ? { id: 2, ground: false, flags: 1 } : null;
      // "You have no chance of provoking those creatures."
      if (picks === 2) f.world.journal.push({ cliloc: 1049446 } as (typeof f.world.journal)[number]);
    };
    const ctx = { ...f.ctx, serial: 1, carried: () => [lute] } as unknown as ProfessionContext;
    expect(await play(ctx, 'Provocation', [a, b])).toBe(false);
    expect(playable(ctx, a) || playable(ctx, b)).toBe(false);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
