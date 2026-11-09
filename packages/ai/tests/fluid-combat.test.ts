import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { assessCombat } from '../src/combat-risk';
import { engageable } from '../src/fighter-prey';
import { canBeat, selfState } from '../src/self-state';
import { required } from './behavior-fixture';
import { fighterFixture } from './fighter-fixture';

for (const health of [17, 31, 49]) {
  test(`remaining opponent health can justify finishing at ${health} health`, () => {
    const f = fighterFixture();
    required(f.world.status).hits = health;
    f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
    const target = {
      serial: 50,
      kind: 'mobile' as const,
      graphic: 3,
      name: 'a zombie',
      hits: 1,
      maxHits: 100,
      position: { x: 101, y: 100, z: 0, direction: 0 }
    };
    expect(canBeat(f.session, selfState(f.session, false), target)).toBe(true);
    expect(engageable(f.ctx, target).ok).toBe(true);
  });
}

test('caster skills and poison affect the forecast without categorically forbidding a finishing hit', () => {
  const f = fighterFixture();
  Object.assign(required(f.world.status), { hits: 150, maxHits: 150 });
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
  f.world.poisonLevel = 1;
  for (const name of ['MagicResist', 'Healing'])
    f.world.skills.set(skillId(name), { base: 0, value: 0, cap: 100, lock: 0 });
  const target = {
    serial: 50,
    kind: 'mobile' as const,
    graphic: 4,
    name: 'a gargoyle',
    hits: 1,
    maxHits: 100,
    position: { x: 101, y: 100, z: 0, direction: 0 }
  };
  expect(canBeat(f.session, selfState(f.session, false), target)).toBe(true);
});

test('ongoing damage is weighed against finishing time rather than an own-health band', () => {
  const options = {
    now: 100000,
    hits: 31,
    maxHits: 100,
    changes: [{ at: 99000, hits: 31, maxHits: 100, damage: 4, healed: 0 }],
    bandages: 0,
    bandageActiveUntil: 0,
    potionReady: false,
    riskTolerance: 0.5,
    opponentHealthRatio: 0.01,
    secondsToDefeat: 0.3
  };
  expect(assessCombat(options).baseline).toBe('press-attack');
  expect(assessCombat({ ...options, opponentHealthRatio: 1, secondsToDefeat: 45 }).baseline).toBe('flee-town');
});

test('the same nearly finished opponent is abandoned when incoming pressure makes finishing worse than escape', () => {
  const options = {
    now: 100000,
    hits: 53,
    maxHits: 100,
    changes: [],
    bandages: 0,
    bandageActiveUntil: 0,
    potionReady: false,
    riskTolerance: 0.5,
    canCreateDistance: true,
    opponentHealthRatio: 0.01,
    secondsToDefeat: 2,
    incomingPerSecond: 1
  };
  expect(assessCombat(options).baseline).toBe('press-attack');
  expect(assessCombat({ ...options, incomingPerSecond: 100 }).baseline).toBe('flee-town');
});

test('additional attackers increase cumulative pressure without an attacker-count prohibition', async () => {
  const { retaliationAssessment } = await import('../src/self-state');
  const f = fighterFixture();
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
  const target = { serial: 50, kind: 'mobile' as const, graphic: 3, name: 'a zombie', hits: 1, maxHits: 100 };
  const self = selfState(f.session, false);
  const alone = retaliationAssessment(f.session, self, target);
  const crowded = retaliationAssessment(
    f.session,
    { ...self, attackers: [target, ...[51, 52, 53].map((serial) => ({ ...target, serial }))] },
    target
  );
  expect(crowded.incomingPerSecond).toBeGreaterThan(alone.incomingPerSecond);
  expect(crowded.attack).toBeGreaterThan(alone.attack);
});

test('small resistance changes modify estimated spell pressure smoothly', async () => {
  const { forecastFight } = await import('../src/combat-forecast');
  const f = fighterFixture();
  const target = { serial: 50, kind: 'mobile' as const, graphic: 4, name: 'a gargoyle', hits: 1, maxHits: 100 };
  const pressures = [39.9, 40, 40.1, 49.9, 50, 50.1, 79.9, 80, 80.1].map((value) => {
    f.world.skills.set(skillId('MagicResist'), { value, base: value, cap: 100, lock: 0 });
    return forecastFight(f.session, target).incomingPerSecond;
  });
  for (let i = 1; i < pressures.length; i++) expect(required(pressures[i])).toBeLessThan(required(pressures[i - 1]));
});

test('ineffective attacks lower the forecast, while confirmed opponent damage restores its measured progress', async () => {
  const { spyOn } = await import('bun:test');
  const { forecastFight } = await import('../src/combat-forecast');
  let now = 100000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = fighterFixture();
    f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
    const target = { serial: 50, kind: 'mobile' as const, graphic: 3, name: 'a zombie', hits: 100, maxHits: 100 };
    f.world.warMode = true;
    f.world.combatant = 50;
    const initial = forecastFight(f.session, target);
    now += 12000;
    const stalled = forecastFight(f.session, target);
    expect(stalled.secondsToDefeat).toBeGreaterThan(initial.secondsToDefeat);
    expect(forecastFight(f.session, { ...target, hits: 10 }).secondsToDefeat).toBeLessThan(stalled.secondsToDefeat);
  } finally {
    clock.mockRestore();
  }
});
