import { expect, test } from 'bun:test';

import { Layer } from '@gemwright/network/layers';

import { ActionInterrupted } from '../src/action-errors';
import { Blocked } from '../src/blocked';
import { hurtOnTheWay } from '../src/cemeteries';
import { decisionContext } from '../src/decision-context';
import { validateDecisionConfig } from '../src/decision-provider';
import { DecisionCoordinator } from '../src/decisions';
import { Ambushed } from '../src/fighter-context';
import { engageable } from '../src/fighter-prey';
import { initializeFighter } from '../src/fighter-startup';
import { createFighterTown } from '../src/fighter-town';
import { planTownTrip, townNeed } from '../src/fighter-trip';
import { LIFE_GOAL } from '../src/life-goal';
import { errand } from '../src/objective-memory';
import { temperamentOf } from '../src/temperament';
import { required } from './behavior-fixture';
import { corpseRecoveryFixture as corpseFixture, fighterFixture as fixture } from './fighter-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();

test('a safe corpse retrieval confirms belongings and returns home before resuming work', async () => {
  const f = corpseFixture();
  await f.recovery.recover();
  expect(f.counts()).toEqual({ clicks: 1, shopping: 1, rests: 1 });
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', attempts: 1 });
  expect(f.ctx.trip.deathSite).toBeUndefined();
  expect(f.ctx.trip.pending).toBe('return');
  expect(f.ctx.stats.recoveredItems).toBe(2);
  expect(f.ctx.stats.abandonedCorpses).toBe(0);
  expect(f.world.entities.get(32)?.parent).toBe(1);
});

test('an interrupted approach preserves the corpse target and a later attempt can recover it', async () => {
  const f = corpseFixture();
  const navigate = f.ctx.navigate;
  f.ctx.navigate = async () => {
    throw new Blocked('unreachable', 'Door temporarily closed');
  };
  await f.recovery.recover();
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(f.ctx.trip.recovery?.retryAt).toBeGreaterThan(Date.now());
  expect(f.ctx.trip.deathSite).toBeDefined();
  expect(f.ctx.stats.abandonedCorpses).toBe(0);
  f.ctx.navigate = navigate;
  required(f.ctx.trip.recovery).retryAt = 0;
  await f.recovery.recover();
  expect(f.counts().clicks).toBe(1);
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', attempts: 2 });
});

test('a corpse click without observed belongings is never reported as successful recovery', async () => {
  const f = corpseFixture();
  f.session.use = () => {};
  await f.recovery.recover();
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(f.ctx.trip.deathSite).toBeDefined();
  expect(f.ctx.stats.recoveredItems).toBe(0);
});

test('healthy fighters without bandages or potions keep hunting viable low-level monsters', async () => {
  const f = fixture();
  f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x13b9, parent: 1, layer: Layer.OneHanded });
  expect(townNeed(f.ctx)).toBeNull();
  for (const [name, graphic] of [
    ['a zombie', 3],
    ['a skeleton', 50],
    ['a mongbat', 39]
  ] as const) {
    f.world.entities.delete(2);
    const target = {
      serial: 2,
      kind: 'mobile' as const,
      graphic,
      name,
      notoriety: 3,
      position: { ...required(f.world.position), x: 101 }
    };
    f.world.entities.set(2, target);
    expect(engageable(f.ctx, target).ok).toBe(true);
  }
  f.world.entities.delete(2);
  f.template.behavior.temperament = { ...temperamentOf('test'), carriedGold: 100 };
  required(f.world.entities.get(11)).amount = 120;
  const decisions = new DecisionCoordinator(validateDecisionConfig({ provider: 'local' }), () => {});
  expect(await planTownTrip(f.ctx, decisions)).toBeNull();
  expect(f.checkpoint.decisions?.history.at(-1)?.selected).toBe('keep-hunting');
  expect(f.checkpoint.decisions?.history.at(-1)?.candidates).toContain('keep-hunting');
});

test('a failed nearby supply opportunity does not become a tour of other shops or an immediate retry', async () => {
  const f = fixture();
  const shop = required(f.ctx.home.shops[0]);
  f.world.position = { ...required(f.world.position), ...shop };
  let visits = 0;
  f.ctx.navigate = async () => {
    visits++;
  };
  const town = createFighterTown(f.ctx, async () => {});
  await town.restock();
  await town.restock();
  expect(visits).toBe(1);
});

test('errands propagate plan cancellation instead of swallowing it as a vendor failure', async () => {
  const f = fixture();
  await expect(
    errand(f.ctx, 'restock:test', 'optional supplies', async () => {
      throw new ActionInterrupted('Plan changed');
    })
  ).rejects.toThrow('Plan changed');
});

test('startup only reconciles observations and every decision context carries the life goal', async () => {
  const f = corpseFixture();
  await initializeFighter(f.ctx);
  expect(f.counts()).toEqual({ clicks: 0, shopping: 0, rests: 0 });
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(decisionContext(f.checkpoint).lifeGoal).toBe(LIFE_GOAL);
});

test('hurt by a caster it cannot see swinging, a healthy fighter turns on the caster instead of going home', () => {
  const { world, ctx } = fixture();
  world.entities.set(60, { serial: 60, kind: 'item', graphic: 0x13ff, parent: 1, layer: Layer.OneHanded });
  // A gazer casting from twelve tiles: no swing packet names it, only the damage arrives.
  world.entities.set(70, {
    serial: 70,
    kind: 'mobile',
    graphic: 22,
    name: 'a gazer',
    notoriety: 3,
    position: { x: 112, y: 100, z: 0, direction: 0 }
  });
  world.healthChanges.push({ at: Date.now(), hits: 90, maxHits: 100, damage: 10, healed: 0 });
  expect(() => hurtOnTheWay(ctx)).toThrow(Ambushed);
});
