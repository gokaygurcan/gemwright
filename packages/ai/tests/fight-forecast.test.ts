import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';
import type { PlayerSession } from '@gemwright/network/session';

import { canBeat, encounterTarget, harmless, selfState } from '../src/fight-forecast';
import { behaviorFixture } from './behavior-fixture';
import { fighterFixture } from './fighter-fixture';

// Finn Gray's numbers: Mace Fighting 81, Tactics 84, Wrestling 40, 102 hit points.
function finn() {
  const f = behaviorFixture();
  for (const [name, value] of [
    ['Mace Fighting', 81],
    ['Tactics', 84],
    ['Wrestling', 40]
  ] as const)
    f.world.skills.set(skillId(name), { id: skillId(name), value, base: value, cap: 100, lock: 0 } as never);
  Object.assign(f.world.status ?? {}, { hits: 102, maxHits: 102 });
  const zombie = (serial: number, x: number) => {
    f.world.entities.set(serial, {
      serial,
      kind: 'mobile',
      graphic: 3,
      name: 'a zombie',
      position: { x, y: 100, z: 0, direction: 0 }
    });
    f.world.swings.set(serial, { target: 1, at: Date.now() });
  };
  return { f, session: f.session as unknown as PlayerSession, zombie };
}

test('a macer at full health beats the zombies hitting it with a maul in hand, or one in its pack', () => {
  const { f, session, zombie } = finn();
  zombie(50, 101);
  zombie(51, 99);
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x143b, parent: 10 });
  const packed = selfState(session, false);
  expect(packed.held).toBeUndefined();
  expect(packed.spare?.graphic).toBe(0x143b);
  expect(packed.attackers.map((m) => m.serial).sort()).toEqual([50, 51]);
  expect(canBeat(session, packed, packed.attackers[0] as never)).toBe(true);
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x143b, parent: 1, layer: 2 });
  const held = selfState(session, false);
  expect(held.held?.serial).toBe(40);
  expect(canBeat(session, held, held.attackers[0] as never)).toBe(true);
});

test('a hostile creature in war mode beside it is fighting it, with no swing packet seen', () => {
  const { f, session } = finn();
  // Finn's graveyard, 22:58: a zombie and a skeleton in war mode (flag 0x40) next to him.
  f.world.entities.set(60, {
    serial: 60,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    flags: 0x40,
    notoriety: 4,
    position: { x: 99, y: 100, z: 0, direction: 0 }
  });
  f.world.entities.set(61, {
    serial: 61,
    kind: 'mobile',
    graphic: 0x38,
    name: 'a skeleton',
    flags: 0x40,
    notoriety: 4,
    position: { x: 101, y: 99, z: 0, direction: 0 }
  });
  // Not in war mode, or too far: not fighting it.
  f.world.entities.set(62, {
    serial: 62,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    flags: 0,
    notoriety: 4,
    position: { x: 100, y: 101, z: 0, direction: 0 }
  });
  f.world.entities.set(63, {
    serial: 63,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    flags: 0x40,
    notoriety: 4,
    position: { x: 108, y: 100, z: 0, direction: 0 }
  });
  expect(
    selfState(session, false)
      .attackers.map((m) => m.serial)
      .sort()
  ).toEqual([60, 61]);
});

test('only what is really hitting it counts, and a fight costing more than it would risk is not taken', () => {
  const { f, session, zombie } = finn();
  zombie(50, 101);
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x143b, parent: 1, layer: 2 });
  // A zombie standing by that is not swinging does not join the fight.
  f.world.entities.set(52, {
    serial: 52,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    position: { x: 102, y: 100, z: 0, direction: 0 }
  });
  expect(selfState(session, false).attackers.map((m) => m.serial)).toEqual([50]);
  Object.assign(f.world.status ?? {}, { hits: 3 });
  const hurt = selfState(session, false);
  expect(canBeat(session, hurt, hurt.attackers[0] as never)).toBe(false);
});

test('cows and boars never start a fight; zombies do', () => {
  const mobile = (graphic: number, name: string) => ({ serial: 9, kind: 'mobile' as const, graphic, name });
  expect(harmless(mobile(0xd8, 'a cow'))).toBe(true);
  expect(harmless(mobile(0x122, 'a boar'))).toBe(true);
  expect(harmless(mobile(3, 'a zombie'))).toBe(false);
});

// Finn Gray, Nov 9: a fight was judged one attacker at a time with all the rest hitting throughout,
// against a flat price for fleeing; two orcs sent a grandmaster swordsman running. The encounter is
// judged whole: the quickest kill first, then the next, fought when it ends with health to spare.
test('a crowd is fought one by one when the whole encounter is winnable, else fled', () => {
  const crowd = (graphic: number, name: string, count: number) => {
    const f = fighterFixture();
    f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13ff, parent: 1, layer: 1 });
    for (let i = 0; i < count; i++) {
      f.world.entities.set(60 + i, {
        serial: 60 + i,
        kind: 'mobile',
        graphic,
        name,
        notoriety: 3,
        hits: 100 - i * 20,
        maxHits: 100,
        position: { x: 101, y: 100, z: 0, direction: 0 }
      });
      f.world.swings.set(60 + i, { target: 1, at: Date.now() });
    }
    return encounterTarget(f.session, selfState(f.session, false));
  };
  // The most wounded orc goes first.
  expect(crowd(17, 'an orc', 2)?.serial).toBe(61);
  expect(crowd(17, 'an orc', 3)).toBeDefined();
  expect(crowd(54, 'a troll', 2)).toBeUndefined();
});

// A defender never receives the swing packet; it sees its attacker's animation (0xE2, ServUO
// Mobile.Animate) and the attacker turned to face it.
test('an attacker is known by its attack animation aimed at the resident, whatever its flags', () => {
  const swingingAt = (direction: number) => {
    const f = fighterFixture();
    f.world.position = { x: 100, y: 100, z: 0, direction: 0 };
    // East of the resident: facing west (6) is facing it.
    f.world.entities.set(80, {
      serial: 80,
      kind: 'mobile',
      graphic: 400,
      name: 'a brigand',
      notoriety: 1,
      position: { x: 101, y: 100, z: 0, direction }
    });
    f.world.animations.set(80, { type: 0, action: 3, at: Date.now() });
    return selfState(f.session, false).attackers.map((m) => m.serial);
  };
  expect(swingingAt(6)).toEqual([80]);
  expect(swingingAt(2)).toEqual([]);
});
