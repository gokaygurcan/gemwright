import { expect, test } from 'bun:test';

import type { FighterContext } from '../src/fighter-context';
import { petFightReadiness } from '../src/pet-risk';
import { observedSpellEffect, requestSpell, type SpellObservation } from '../src/spell-action';
import { behaviorFixture, required } from './behavior-fixture';

const before: SpellObservation = {
  hits: 60,
  poison: 2,
  strength: 50,
  dexterity: 50,
  intelligence: 50,
  followers: 0,
  targetHits: 100,
  targetPoison: false,
  targetDead: false
};

test('spell effects require observable recovery, buff, poison or summon changes', () => {
  expect(observedSpellEffect('Bless', before, before)).toBe(false);
  expect(observedSpellEffect('Bless', before, { ...before, strength: 55 })).toBe(true);
  expect(observedSpellEffect('Cure', before, { ...before, poison: 0 })).toBe(true);
  expect(observedSpellEffect('Cure', before, { ...before, poison: 1 })).toBe(false);
  expect(observedSpellEffect('Heal', before, { ...before, hits: 70 })).toBe(true);
  expect(observedSpellEffect('Summon Creature', before, before)).toBe(false);
  expect(observedSpellEffect('Summon Creature', before, { ...before, followers: 1 })).toBe(true);
});

function spellFixture() {
  const f = behaviorFixture();
  const ctx = {
    ...f.ctx,
    serial: 1,
    status: () => required(f.world.status),
    contents: () => f.world.childrenOf(10)
  } as unknown as FighterContext;
  f.session.useSkill = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  return { ...f, ctx };
}

test("a targeted heal needs observed recovery and ignores another caster's fizzle", async () => {
  const { ctx, session, world } = spellFixture();
  required(world.status).hits = 60;
  session.target = () => {
    world.target = null;
    required(world.status).hits = 75;
    world.journal.push({ at: new Date().toISOString(), serial: 2, name: 'another caster', cliloc: 502632 });
  };
  expect(await requestSpell(ctx, { id: 3, name: 'Heal', circle: 1 }, { serial: 1, graphic: 400 }, new Set())).toBe(
    'confirmed'
  );
});

test('a missing spell is remembered as failure and never sent to the target cursor', async () => {
  const { ctx, session, world } = spellFixture();
  session.useSkill = () => {
    world.journal.push({ at: new Date().toISOString(), serial: 1, name: '', cliloc: 500015 });
  };
  let targeted = false;
  session.target = () => {
    targeted = true;
  };
  const missing = new Set<number>();
  expect(await requestSpell(ctx, { id: 17, name: 'Bless', circle: 3 }, { serial: 1, graphic: 400 }, missing)).toBe(
    'failed'
  );
  expect(missing.has(17)).toBe(true);
  expect(targeted).toBe(false);
});

test('sending a spell target without any resulting observation remains unknown', async () => {
  const { ctx } = spellFixture();
  expect(await requestSpell(ctx, { id: 17, name: 'Bless', circle: 3 }, { serial: 1, graphic: 400 }, new Set())).toBe(
    'unknown'
  );
});

test('an emergency cancels a pending spell cursor and propagates to escape handling', async () => {
  const { ctx, world } = spellFixture();
  let checks = 0;
  ctx.check = () => {
    if (++checks > 2) throw new Error('escape now');
  };
  await expect(
    requestSpell(ctx, { id: 17, name: 'Bless', circle: 3 }, { serial: 1, graphic: 400 }, new Set())
  ).rejects.toThrow('escape now');
  expect(world.target).toBeNull();
});

test('companions require known health and a credible match; a bear is not sent against a lich', () => {
  const pet = { serial: 2, kind: 'mobile' as const, graphic: 212, name: 'a grizzly bear', hits: 100, maxHits: 100 };
  const zombie = { serial: 3, kind: 'mobile' as const, graphic: 3, name: 'a zombie' };
  expect(petFightReadiness(pet, zombie, 10, 50).ok).toBe(true);
  expect(petFightReadiness({ ...pet, hits: undefined }, zombie, 10, 50).ok).toBe(false);
  expect(petFightReadiness({ ...pet, hits: 30 }, zombie, 10, 50).ok).toBe(false);
  expect(petFightReadiness(pet, { ...zombie, graphic: 24, name: 'a lich' }, 10, 50).ok).toBe(false);
  expect(petFightReadiness(pet, { ...zombie, name: 'unknown monster' }, 10, 50).ok).toBe(false);
});

test('a failed pet attack still recalls the companion and releases the urgent action', async () => {
  const { fightWithPet } = await import('../src/tamer-pet');
  const { canPause } = await import('../src/action-purpose');
  const { session, world, ctx: life } = behaviorFixture('tamer');
  const pet = {
    serial: 2,
    kind: 'mobile' as const,
    graphic: 212,
    name: 'a grizzly bear',
    hits: 100,
    maxHits: 100,
    position: { ...required(world.position), x: 101 }
  };
  const foe = {
    serial: 3,
    kind: 'mobile' as const,
    graphic: 3,
    name: 'a zombie',
    notoriety: 3,
    position: { ...required(world.position), x: 103 }
  };
  world.entities.set(2, pet);
  world.entities.set(3, foe);
  life.checkpoint.companion = { serial: 2, name: pet.name, minTame: 60 };
  const { skillId } = await import('@gemwright/common/skills');
  world.skills.set(skillId('Veterinary'), { value: 50, base: 50, cap: 100, lock: 0 });
  session.inspect = async () => {};
  session.context = async () => [{ index: 0, cliloc: 3006111, flags: 0 }];
  session.selectContext = () => {
    world.target = { id: 1, ground: false, flags: 0 };
  };
  session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('No cursor');
  };
  const spoken: string[] = [];
  session.say = (line) => {
    spoken.push(line);
  };
  session.target = (target) => {
    if (target?.serial === 3) throw new Error('Command interrupted');
    world.target = null;
  };
  const ctx = {
    ...life,
    serial: 1,
    status: () => required(world.status),
    progress: {},
    count: () => 20,
    carried: () => world.childrenOf(10)
  } as unknown as import('../src/profession').ProfessionContext;
  await expect(fightWithPet(ctx, () => false)).rejects.toThrow('Command interrupted');
  expect(spoken).toContain('all follow me');
  expect(world.target).toBeNull();
  expect(canPause(session)).toBe(true);
});
