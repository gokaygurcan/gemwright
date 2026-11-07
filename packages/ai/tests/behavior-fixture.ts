import { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import type { CharacterTemplate } from '../src/config';
import type { LifeContext } from '../src/life';
import type { Checkpoint } from '../src/store';
import type { Terrain } from '../src/terrain';

export function behaviorFixture(profession = 'tailor') {
  const world = new WorldView();
  world.serial = 1;
  world.map = 1;
  world.position = { x: 100, y: 100, z: 0, direction: 2 };
  world.status = {
    hits: 100,
    maxHits: 100,
    mana: 40,
    maxMana: 100,
    stamina: 100,
    maxStamina: 100,
    strength: 50,
    dexterity: 50,
    intelligence: 50,
    armor: 0,
    weight: 10,
    maxWeight: 200,
    gold: 1000,
    followers: 0,
    maxFollowers: 5
  };
  world.entities.set(1, { serial: 1, kind: 'mobile', graphic: 400, position: world.position });
  world.entities.set(10, { serial: 10, kind: 'item', graphic: 0xe75, parent: 1, layer: 21 });
  world.entities.set(11, { serial: 11, kind: 'item', graphic: 0xeed, parent: 10, amount: 1000 });
  for (const field of ['health', 'mana', 'stamina', 'weight', 'gold', 'position', 'map', 'poison'] as const)
    world.observations.fieldAt.set(field, Date.now());
  const session = {
    world,
    phase: 'ready',
    target: () => {
      world.target = null;
    },
    resyncPosition: async () => false,
    // The real session's rule: a cursor left up over ten seconds is cancelled, a fresh one is not.
    releaseStaleCursor: (now = Date.now()) =>
      PlayerSession.prototype.releaseStaleCursor.call({ world, send: () => {} }, now),
    // The shard shows a container's contents when it is opened; anything else has no reply.
    use: (serial: number) => {
      if (world.entities.get(serial)?.parent !== undefined)
        world.received.set(0x3c, (world.received.get(0x3c) ?? 0) + 1);
    }
  } as unknown as PlayerSession;
  const checkpoint: Checkpoint = { goal: null, memories: [], relationships: {} };
  const template = {
    id: 'test-resident',
    archetype: { id: profession, primarySkills: [], supportingSkills: [] },
    behavior: { sociability: 0.5, riskTolerance: 0.5, trainingGoals: {} }
  } as unknown as CharacterTemplate;
  const terrain = {
    stand: (x: number, y: number, z: number) => ({ x, y, z }),
    tile: () => ({ flags: 0, height: 0, layer: 2 }),
    cell: () => ({ statics: [] }),
    pathAsync: async (_from: unknown, goal: { x: number; y: number }) => [{ ...goal, z: 0 }]
  } as unknown as Terrain;
  const ctx: LifeContext = {
    session,
    checkpoint,
    template,
    terrain,
    city: 'Britain',
    position: () => required(world.position),
    check: () => {},
    phase: () => {},
    log: () => {},
    persist: () => {},
    navigate: async (goal) => {
      world.position = { ...required(world.position), ...goal };
    },
    practise: async () => {}
  };
  return { world, session, checkpoint, template, terrain, ctx };
}

export function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error('Missing behavior fixture observation');
  return value;
}
