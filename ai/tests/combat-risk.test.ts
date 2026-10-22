import { expect, test } from 'bun:test';

import { assessCombat, type HealthChange } from '../src/combat-risk';
import { WorldView } from '../src/protocol/world';

const now = 100000;
const change = (damage: number, age: number, hits: number, healed = 0): HealthChange => ({
  at: now - age,
  hits,
  maxHits: 100,
  damage,
  healed
});
const assess = (hits: number, changes: HealthChange[], bandages = 10) =>
  assessCombat({
    now,
    hits,
    maxHits: 100,
    changes,
    bandages,
    bandageActiveUntil: 0,
    potionReady: false,
    riskTolerance: 0.5,
    canCreateDistance: true,
    opponentHealthRatio: 0.8
  });

test('a first hit removing sixty percent forces escape before another exchange', () => {
  const risk = assess(40, [change(60, 100, 40)]);
  expect(risk.emergency).toBe(true);
  expect(risk.baseline).toBe('flee-town');
  expect(risk.largestHit).toBe(60);
});
test('slow damage permits fighting or a short bandage withdrawal instead of always returning to town', () => {
  expect(assess(90, [change(3, 7000, 96), change(3, 4000, 93), change(3, 1000, 90)]).baseline).toBe('press-attack');
  const changes = [change(5, 7000, 65), change(5, 3000, 60)];
  expect(assess(60, changes).baseline).toBe('bandage-break');
  expect(assess(60, changes, 0).baseline).toBe('flee-town');
  expect(assess(85, [change(15, 100, 85)]).baseline).toBe('bandage-break');
});
test('healing does not cancel the incoming damage used to estimate danger', () => {
  const risk = assess(40, [change(60, 2000, 40), change(0, 1500, 80, 40), change(40, 100, 40)]);
  expect(risk.damageLast3s).toBe(100);
  expect(risk.healingLast8s).toBe(40);
  expect(risk.emergency).toBe(true);
});
test('duplicate health packets do not count a hit twice, and healing remains separate', () => {
  const world = new WorldView();
  world.serial = 1;
  world.status = {
    intelligence: 25,
    mana: 0,
    maxMana: 0,
    hits: 100,
    maxHits: 100,
    stamina: 30,
    maxStamina: 30,
    gold: 0,
    strength: 50,
    dexterity: 50,
    armor: 0,
    weight: 0,
    maxWeight: 200
  };
  const hits = (value: number) => {
    const packet = Buffer.alloc(9);
    packet[0] = 0xa1;
    packet.writeUInt32BE(1, 1);
    packet.writeUInt16BE(100, 5);
    packet.writeUInt16BE(value, 7);
    world.apply(packet);
  };
  hits(40);
  hits(40);
  hits(70);
  hits(30);
  expect(world.healthChanges.map((change) => change.damage)).toEqual([60, 0, 40]);
  expect(world.healthChanges.map((change) => change.healed)).toEqual([0, 30, 0]);
});

test('observed Healing values retain tenths and a delta updates the same skill as the full list', () => {
  const world = new WorldView();
  const full = Buffer.alloc(15);
  full[0] = 0x3a;
  full.writeUInt16BE(15, 1);
  full[3] = 2;
  full.writeUInt16BE(18, 4);
  full.writeUInt16BE(35, 6);
  full.writeUInt16BE(12, 8);
  full.writeUInt16BE(1000, 11);
  world.apply(full);
  expect(world.skills.get(17)?.value).toBe(3.5);
  expect(world.skills.get(17)?.base).toBe(1.2);
  const delta = Buffer.from(full.subarray(0, 13));
  delta.writeUInt16BE(13, 1);
  delta[3] = 0xdf;
  delta.writeUInt16BE(17, 4);
  delta.writeUInt16BE(36, 6);
  world.apply(delta);
  expect(world.skills.size).toBe(1);
  expect(world.skills.get(17)?.value).toBe(3.6);
});
