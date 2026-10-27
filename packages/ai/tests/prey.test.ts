import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/skills';

import type { FighterContext } from '../src/fighter-context';
import { chooseOpponent } from '../src/fighter-hunt';
import { engageable } from '../src/fighter-prey';
import type { Entity } from '../src/protocol/world';

const mobile = (serial: number, graphic: number, name: string, x = 10): Entity => ({
  serial,
  kind: 'mobile',
  graphic,
  name,
  notoriety: 3,
  position: { x, y: 10, z: 0, direction: 0 }
});

function fighter(options: {
  swords: number;
  tactics: number;
  armor?: number;
  others?: Entity[];
  resist?: number;
  healing?: number;
}) {
  const value = (amount: number) => ({ value: amount, base: amount, cap: 100, lock: 0 });
  const skills = new Map([
    [skillId('Swordsmanship'), value(options.swords)],
    [skillId('Tactics'), value(options.tactics)],
    [skillId('MagicResist'), value(options.resist ?? 0)],
    [skillId('Healing'), value(options.healing ?? 0)]
  ]);
  return {
    session: { world: { skills, childrenOf: () => [{ layer: 1, graphic: 0x13ff }] } },
    template: { behavior: { riskTolerance: 0.5 } },
    status: () => ({ hits: 90, maxHits: 90, armor: options.armor ?? 0 }),
    position: () => ({ x: 0, y: 10, z: 0, direction: 0 }),
    nearby: () => options.others ?? [],
    count: () => 30
  } as unknown as FighterContext;
}

test('common undead are always engageable; casters require readiness', () => {
  const novice = fighter({ swords: 40, tactics: 40 });
  expect(engageable(novice, mobile(1, 3, 'a zombie')).ok).toBe(true);
  const wraith = engageable(novice, mobile(2, 26, 'a wraith'));
  expect(wraith.ok).toBe(false);
  expect(wraith.reason).toContain('swordsmanship');
  // Bram's live profile (swords 60, tactics 55, no resist) lost three of three caster fights.
  expect(engageable(fighter({ swords: 60, tactics: 55, armor: 16 }), mobile(2, 26, 'a wraith')).ok).toBe(false);
  const ready = fighter({ swords: 75, tactics: 70, armor: 20, resist: 45, healing: 60 });
  expect(engageable(ready, mobile(2, 26, 'a wraith')).ok).toBe(true);
});

test('a lich needs exceptional readiness and a lich lord is never engaged', () => {
  const veteran = fighter({ swords: 90, tactics: 90, armor: 30 });
  expect(engageable(veteran, mobile(3, 24, 'a lich')).ok).toBe(false);
  const lord = engageable(fighter({ swords: 120, tactics: 120, armor: 70 }), mobile(4, 79, 'a lich lord'));
  expect(lord.ok).toBe(false);
});

test('a dangerous undead nearby rules out an otherwise easy target', () => {
  const lich = mobile(5, 24, 'a lich', 14);
  const result = engageable(fighter({ swords: 40, tactics: 40, others: [lich] }), mobile(6, 3, 'a zombie'));
  expect(result.ok).toBe(false);
  expect(result.reason).toContain('a lich');
});

test('a body shared by several undead is resolved by the observed name', () => {
  const ready = fighter({ swords: 60, tactics: 55 });
  expect(engageable(ready, mobile(7, 153, 'a ghoul')).ok).toBe(true);
  expect(engageable(ready, mobile(8, 153, 'a mongbat')).ok).toBe(false);
});

test('an opponent disappearing during inspection does not stop the hunter', async () => {
  const target = mobile(9, 3, '');
  const ctx = fighter({ swords: 40, tactics: 40, others: [target] });
  Object.assign(ctx, {
    checkpoint: {},
    check: () => {},
    session: {
      phase: 'ready',
      world: { map: 1, entities: new Map() },
      inspect: async () => {
        throw new Error('Timed out waiting for observed character name');
      }
    }
  });
  expect(await chooseOpponent(ctx, { unreachable: new Set() })).toEqual({ kind: 'patrol', pick: null });
  ctx.session.inspect = async () => {
    throw new Error('Connection lost');
  };
  await expect(chooseOpponent(ctx, { unreachable: new Set() })).rejects.toThrow('Connection lost');
});
