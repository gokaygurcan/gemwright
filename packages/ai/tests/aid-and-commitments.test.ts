import { expect, test } from 'bun:test';

import { hearAid, observeAid, shelterNearHelper } from '../src/aid';
import { commitmentConversation, commitmentTurn } from '../src/commitments';
import { registerCombat } from '../src/resident-context';
import { personalMemory, rememberPartner, sharedMemoryLine } from '../src/resident-memory';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function familiar(f: ReturnType<typeof socialFixture>) {
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    notoriety: 1,
    name: 'Ada',
    position: { ...required(f.world.position), x: 102 }
  });
  rememberPartner(f.checkpoint, {
    partner: 2,
    name: 'Ada',
    kind: 'conversation',
    detail: 'Greeted each other',
    id: 'hello'
  });
  rememberPartner(f.checkpoint, {
    partner: 2,
    name: 'Ada',
    kind: 'conversation',
    detail: 'Discussed the destination',
    id: 'destination'
  });
}

test("nearby combat alone is not a rescue; attacking the resident's actual opponent is observed help", () => {
  const f = socialFixture('swordsman');
  familiar(f);
  f.world.entities.set(3, {
    serial: 3,
    kind: 'mobile',
    graphic: 3,
    notoriety: 3,
    name: 'a zombie',
    position: { ...required(f.world.position), x: 105 }
  });
  f.world.swings.set(2, { target: 3, at: Date.now() });
  expect(observeAid(f.session)).toHaveLength(0);
  f.world.combatant = 3;
  expect(observeAid(f.session).map((helper) => helper.serial)).toContain(2);
  expect(f.checkpoint.personal?.episodes.some((episode) => episode.kind === 'rescue')).toBe(true);
  observeAid(f.session);
  expect(f.checkpoint.personal?.episodes.filter((episode) => episode.kind === 'rescue')).toHaveLength(1);
});

test('an offer of help can guide a safe withdrawal but cannot grant knowledge of an unseen player', async () => {
  const f = socialFixture();
  familiar(f);
  const entry = { at: new Date().toISOString(), serial: 2, name: 'Ada', text: 'Let me help you, get behind me' };
  expect(hearAid(f.session, entry)).toBe(true);
  const shelter = await shelterNearHelper(f.session, f.terrain, f.ctx.check);
  expect(shelter).toBeDefined();
  f.world.entities.delete(2);
  expect(observeAid(f.session)).toHaveLength(0);
  expect(await shelterNearHelper(f.session, f.terrain, f.ctx.check)).toBeUndefined();
});

test('a stranger is asked about their plans before a follow commitment is made', () => {
  const f = socialFixture();
  expect(commitmentConversation(f.session, 2, 'Ada', 'follow me')).toContain('Where are you heading');
  expect(f.checkpoint.personal?.commitment).toBeUndefined();
  familiar(f);
  expect(commitmentConversation(f.session, 2, 'Ada', 'follow me')).toContain('come along');
  expect(f.checkpoint.personal?.commitment?.kind).toBe('follow');
});

test('a follow commitment actually moves toward its observed partner, and a changed facet cancels it honestly', async () => {
  const f = socialFixture();
  familiar(f);
  required(f.world.entities.get(2)).position = { ...required(f.world.position), x: 108 };
  commitmentConversation(f.session, 2, 'Ada', 'follow me');
  let destination = 0;
  f.ctx.navigate = async (point) => {
    destination = point.x;
  };
  expect(await commitmentTurn(f.ctx)).toBe(true);
  expect(destination).toBe(108);
  f.world.map = 0;
  expect(await commitmentTurn(f.ctx)).toBe(false);
  expect(f.checkpoint.personal?.commitment?.state).toBe('cancelled');
  expect(f.checkpoint.personal?.episodes.findLast((episode) => episode.kind === 'commitment-ended')?.result).toBe(
    'interrupted'
  );
});

test('cooperative hunting attacks only a supported observed target and reserves a share of collected gold', async () => {
  const f = socialFixture('swordsman');
  familiar(f);
  const enemy = {
    serial: 3,
    kind: 'mobile' as const,
    graphic: 3,
    name: 'a zombie',
    notoriety: 3,
    position: { ...required(f.world.position), x: 105 }
  };
  f.world.entities.set(3, enemy);
  f.world.swings.set(2, { target: 3, at: Date.now() });
  registerCombat(f.session, {
    canFight: (target) => target.serial === 3,
    fight: async (target) => {
      f.world.deaths.set(target.serial, { corpse: 100 });
      required(f.world.entities.get(11)).amount = 1040;
    }
  });
  expect(commitmentConversation(f.session, 2, 'Ada', 'come hunt with me')).toContain('hunt nearby');
  expect(await commitmentTurn(f.ctx)).toBe(true);
  expect(f.checkpoint.personal?.commitment?.kills).toBe(1);
  expect(f.checkpoint.personal?.commitment?.lootDue).toBe(20);
  expect(sharedMemoryLine(f.checkpoint, 2)).toContain('outing');
});

test('a successful command without an observed death does not invent a shared kill', async () => {
  const f = socialFixture('swordsman');
  familiar(f);
  const enemy = { serial: 3, kind: 'mobile' as const, graphic: 3, position: { ...required(f.world.position), x: 105 } };
  f.world.entities.set(3, enemy);
  f.world.swings.set(2, { target: 3, at: Date.now() });
  registerCombat(f.session, { canFight: () => true, fight: async () => {} });
  commitmentConversation(f.session, 2, 'Ada', 'come hunt with me');
  await commitmentTurn(f.ctx);
  expect(f.checkpoint.personal?.commitment?.kills).toBe(0);
  expect(f.checkpoint.personal?.episodes.some((episode) => episode.kind === 'outing')).toBe(false);
});

test('relationship events deduplicate, survive checkpoint serialization, and do not punish an interruption as betrayal', () => {
  const f = socialFixture();
  const event = {
    partner: 2,
    name: 'Ada',
    kind: 'gift' as const,
    detail: 'Gave useful bandages',
    id: 'gift:1',
    result: 'completed' as const
  };
  rememberPartner(f.checkpoint, event);
  rememberPartner(f.checkpoint, event);
  const trust = f.checkpoint.personal?.partners[2]?.trust;
  rememberPartner(f.checkpoint, { ...event, id: 'interrupted', kind: 'commitment-ended', result: 'interrupted' });
  expect(f.checkpoint.personal?.partners[2]?.trust).toBe(trust);
  const reopened = JSON.parse(JSON.stringify(f.checkpoint));
  expect(personalMemory(reopened).episodes.filter((episode) => episode.id === 'gift:1')).toHaveLength(1);
  expect(sharedMemoryLine(reopened, 2)).toContain('supplies');
  expect(sharedMemoryLine(reopened, 999)).toBeUndefined();
});
