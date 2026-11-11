import { expect, test } from 'bun:test';

import { bandage, curePotion, spellbook } from '@gemwright/common/game/items';
import { ShardMessage } from '@gemwright/network/replies';

import { spellNamed } from '../src/v1/spell-rules';
import { takeTreatment, treatment } from '../src/v2/medicine';
import { Mind } from '../src/v2/mind';
import { traitsOf } from '../src/v2/traits';
import { behaviorFixture, required } from './behavior-fixture';

function poisoned(skills: Record<string, number> = {}) {
  const f = behaviorFixture('swordsman');
  f.world.poisonLevel = 2;
  f.session.waitFor = async (predicate, label) => {
    if (!predicate()) throw new Error(`No server reply: ${label}`);
  };
  const recorded: object[] = [];
  const mind = new Mind('r', (event) => recorded.push(event), traitsOf([], () => 0.5).traits);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {}, skills } });
  return { ...f, mind, recorded };
}

test('no supplies or cure skill is not mistaken for a treatment capability', () => {
  const f = poisoned();
  expect(treatment(f.session, f.mind)).toBeUndefined();
  f.world.put({ serial: 20, kind: 'item', graphic: bandage, parent: 10 });
  expect(treatment(f.session, f.mind)).toBeUndefined();
});

test('poison treatment requires an actual cure effect rather than merely using the potion', async () => {
  const f = poisoned();
  f.world.put({ serial: 20, kind: 'item', graphic: curePotion, parent: 10 });
  const medicine = treatment(f.session, f.mind);
  expect(medicine).toEqual({ kind: 'potion', serial: 20, cure: true });
  f.session.use = () => {
    f.world.poisonLevel = 0;
  };
  expect(await takeTreatment(f.session, f.mind, required(medicine), () => true)).toBe(true);
});

test('bandages can cure only with both required skills and target the resident', async () => {
  const f = poisoned({ Healing: 60, Anatomy: 60 });
  f.world.put({ serial: 20, kind: 'item', graphic: bandage, parent: 10 });
  const medicine = treatment(f.session, f.mind);
  expect(medicine).toEqual({ kind: 'bandage', serial: 20, cure: true });
  f.session.use = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  f.session.target = (location) => {
    expect(location?.serial).toBe(1);
    f.world.target = null;
    f.world.poisonLevel = 0;
  };
  expect(await takeTreatment(f.session, f.mind, required(medicine), () => true)).toBe(true);
});

test('a confirmed missing spell is learned and survives checkpoint restoration', async () => {
  const f = poisoned({ Magery: 100 });
  const cure = spellNamed('Cure');
  f.world.put({ serial: 20, kind: 'item', graphic: spellbook, parent: 10 });
  for (const [index, graphic] of cure.reagents.entries())
    f.world.put({ serial: 30 + index, kind: 'item', graphic, amount: 10, parent: 10 });
  const medicine = treatment(f.session, f.mind);
  expect(medicine).toEqual({ kind: 'spell', spell: cure.id, cure: true });
  f.session.useSkill = () => {
    f.world.addJournal({ serial: 0xffffffff, name: 'System', cliloc: ShardMessage.noSuchSpell });
  };
  expect(await takeTreatment(f.session, f.mind, required(medicine), () => true)).toBe(false);
  expect(treatment(f.session, f.mind)).toBeUndefined();
  expect(f.recorded).toContainEqual(expect.objectContaining({ kind: 'spell-missing', data: { spell: cure.id } }));
  const resumed = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  resumed.restore(structuredClone(f.mind.snapshot()));
  expect(resumed.spellMissing(cure.id)).toBe(true);
});

test('cancelled treatment sends no use or target command', async () => {
  const f = poisoned();
  f.session.use = () => {
    throw new Error('Cancelled treatment used a potion');
  };
  expect(await takeTreatment(f.session, f.mind, { kind: 'potion', serial: 20, cure: true }, () => false)).toBe(false);
});
