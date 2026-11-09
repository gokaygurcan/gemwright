import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { groundFits, grounds, retreatedFrom } from '../src/cemeteries';
import { recoveryThreats, returnToRefuge } from '../src/fighter-refuge';
import { monsters } from '../src/monster-reference';
import { canBeat, fightShare, selfState } from '../src/self-state';
import { required } from './behavior-fixture';
import { fighterFixture } from './fighter-fixture';

for (const type of ['Gargoyle', 'Reaper']) {
  test(`${type}: resistance changes the damage estimate without a creature-type ban`, () => {
    const f = fighterFixture();
    const stats = required(monsters.find((m) => m.type === type));
    const target = {
      serial: 50,
      kind: 'mobile' as const,
      graphic: required(stats.bodies[0]),
      name: stats.name ?? undefined
    };
    f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
    f.world.skills.set(skillId('MagicResist'), { base: 0, value: 0, cap: 100, lock: 0 });
    f.world.skills.set(skillId('Healing'), { base: 0, value: 0, cap: 100, lock: 0 });
    const unprotected = fightShare(f.session, target, selfState(f.session, false).held, 100);
    expect(
      groundFits(f.ctx, { name: 'danger', center: { x: 1644, y: 1421 }, gate: 'britain', creatures: { [type]: 1 } })
    ).toBe(true);
    f.world.skills.set(skillId('MagicResist'), { base: 100, value: 100, cap: 100, lock: 0 });
    expect(fightShare(f.session, target, selfState(f.session, false).held, 100)).toBeLessThan(unprotected);
  });
}

test('poison adds pressure to the forecast instead of unconditionally forbidding combat', () => {
  const f = fighterFixture();
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
  const target = { serial: 50, kind: 'mobile' as const, graphic: 3, name: 'a zombie', hits: 1, maxHits: 100 };
  const before = fightShare(f.session, target, selfState(f.session, false).held, 100);
  f.world.poisonLevel = 1;
  expect(fightShare(f.session, target, selfState(f.session, false).held, 100)).toBeGreaterThan(before);
  expect(canBeat(f.session, selfState(f.session, false), target)).toBe(true);
});

test('ordinary health recovery accepts an unthreatened field position without returning to a bank', async () => {
  const f = fighterFixture();
  f.world.position = { x: 1500, y: 1450, z: 0, direction: 0 };
  Object.assign(required(f.world.status), { hits: 60 });
  const walks: unknown[] = [];
  f.ctx.escapeNavigate = async (point) => {
    walks.push(point);
  };
  await returnToRefuge(f.ctx);
  expect(walks).toEqual([]);
  expect(f.ctx.trip.pending).toBe('hunt');
});

test('repeated retreats do not blacklist a creature type or another ground', () => {
  const f = fighterFixture();
  f.world.serial = 910001;
  f.ctx.serial = 910001;
  Object.assign(required(f.world.status), { hits: 1000, maxHits: 1000 });
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 910001, layer: 1 });
  const first = {
    name: 'regression-gargoyles',
    center: { x: 1644, y: 1421 },
    gate: 'britain' as const,
    creatures: { Gargoyle: 1 }
  };
  grounds.push(first);
  f.ctx.trip.ground = first.name;
  f.world.entities.set(50, { serial: 50, kind: 'mobile', graphic: 4, name: 'a gargoyle' });
  f.ctx.state.fightingSerial = 50;
  const other = { ...first, name: 'other-gargoyles', center: { x: 1969, y: 1409 } };
  try {
    expect(groundFits(f.ctx, other)).toBe(true);
    retreatedFrom(f.ctx);
    retreatedFrom(f.ctx);
    expect(groundFits(f.ctx, other)).toBe(true);
    f.world.skills.set(skillId('MagicResist'), { base: 110, value: 110, cap: 120, lock: 0 });
    expect(groundFits(f.ctx, other)).toBe(true);
  } finally {
    grounds.splice(grounds.indexOf(first), 1);
  }
});

test('a caster ten tiles away prevents declaring a field position safe for recovery', () => {
  const f = fighterFixture();
  f.world.entities.set(50, {
    serial: 50,
    kind: 'mobile',
    graphic: 47,
    name: 'a reaper',
    notoriety: 3,
    position: { x: 110, y: 100, z: 0, direction: 0 }
  });
  expect(recoveryThreats(f.ctx).map((mobile) => mobile.serial)).toEqual([50]);
});
