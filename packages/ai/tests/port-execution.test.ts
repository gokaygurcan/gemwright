import { expect, test } from 'bun:test';

import { Opcode } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import type { Encounter } from '../src/encounter';
import { Hands } from '../src/hands';
import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import type { Terrain } from '../src/terrain';
import { traitsOf } from '../src/traits';

function client() {
  const world = new WorldView();
  world.serial = 1;
  world.map = 1;
  world.position = { x: 900, y: 900, z: 0, direction: 0 };
  world.put({ serial: 1, kind: 'mobile', graphic: 400 });
  world.put({ serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 });
  world.put({ serial: 5, kind: 'item', graphic: 2475, parent: 1, layer: 29 });
  const sent: string[] = [];
  const session = {
    world,
    phase: 'ready',
    use: (id: number) => {
      sent.push(`use ${id}`);
    },
    say: (text: string) => {
      sent.push(text);
    },
    moveItem: async (id: number, parent: number, amount?: number) => {
      sent.push(`move ${id} ${parent} ${amount ?? 'all'}`);
      const item = world.entities.get(id);
      if (item) world.put({ ...item, parent });
    },
    inspectProperties: async () => {},
    refreshStatus: async () => {},
    resyncPosition: async () => {},
    target: () => {
      world.target = null;
    }
  } as unknown as PlayerSession;
  const mind = new Mind('ports', () => {}, traitsOf([], () => 0.5).traits);
  const stop = perceive(session, 'ports', (e) => mind.observe(e));
  const hands = new Hands(
    session,
    undefined,
    () => undefined,
    (id) => mind.call(id)
  );
  hands.notice = (kind, data) => mind.notice(kind, data);
  return { world, session, mind, hands, sent, stop };
}

test('opening an own corpse accepts ServUO self-loot of belongings with no sale value', async () => {
  const c = client();
  c.mind.notice('died', {});
  c.world.put({ serial: 40, kind: 'item', graphic: 8198, position: { x: 900, y: 900, z: 0, direction: 0 } });
  c.world.put({ serial: 41, kind: 'item', graphic: 0x1f03, parent: 40 });
  c.session.use = (id) => {
    c.sent.push(`use ${id}`);
    c.world.put({ serial: 41, kind: 'item', graphic: 0x1f03, parent: 2 });
  };
  try {
    expect(c.mind.call(40)).toBe('my Corpse');
    expect(await c.hands.do({ verb: 'recover-corpse', serial: 40 }, () => true)).toBe(true);
    expect(c.world.entities.get(41)?.parent).toBe(2);
    expect(c.mind.care.corpse).toBeUndefined();
  } finally {
    c.stop();
  }
});

test('failed corpse recovery keeps its history instead of claiming a recovery', async () => {
  const c = client();
  c.mind.notice('died', {});
  try {
    expect(await c.hands.do({ verb: 'recover-corpse', serial: 40 }, () => true)).toBe(false);
    expect(c.mind.care.corpse).toBeDefined();
  } finally {
    c.stop();
  }
});

test('a nested full bank is refused before sending a deposit', async () => {
  const c = client();
  c.world.put({ serial: 6, kind: 'item', graphic: 3701, parent: 5 });
  for (let i = 0; i < 124; i++) c.world.put({ serial: 100 + i, kind: 'item', graphic: 3934, parent: 6 });
  c.world.put({ serial: 9, kind: 'item', graphic: 3821, amount: 100, parent: 2 });
  try {
    expect(await c.hands.do({ verb: 'deposit', items: [9] }, () => true)).toBe(false);
    expect(c.sent).toEqual([]);
    expect(c.world.entities.get(9)?.parent).toBe(2);
    expect(await c.hands.do({ verb: 'clear-bank', serial: 100 }, () => true)).toBe(true);
    expect(await c.hands.do({ verb: 'deposit', items: [9] }, () => true)).toBe(true);
    expect(c.world.entities.get(100)?.parent).toBe(2);
    expect(c.world.entities.get(9)?.parent).toBe(5);
  } finally {
    c.stop();
  }
});

test('the bank hover counts unseen nested contents before any deposit', async () => {
  const c = client();
  c.world.put({
    serial: 5,
    kind: 'item',
    graphic: 2475,
    parent: 1,
    layer: 29,
    properties: [{ cliloc: 1073841, arguments: '125\t125\t0' }]
  });
  c.world.put({ serial: 9, kind: 'item', graphic: 3821, parent: 2 });
  try {
    expect(c.mind.bankCapacity.count).toBe(125);
    expect(await c.hands.do({ verb: 'deposit', items: [9] }, () => true)).toBe(false);
    expect(c.sent).toEqual([]);
  } finally {
    c.stop();
  }
});

test('scavenging rechecks movable flags, reach, capacity and actual transfer', async () => {
  const c = client();
  c.world.put({
    serial: 9,
    kind: 'item',
    graphic: 3821,
    amount: 100,
    flags: 32,
    position: { x: 901, y: 900, z: 0, direction: 0 },
    properties: [{ cliloc: 1072789, arguments: '2' }]
  });
  try {
    expect(await c.hands.do({ verb: 'pickup', serial: 9, amount: 100 }, () => true)).toBe(true);
    expect(c.mind.carrying(9)).toBe(true);
    c.world.put({
      serial: 10,
      kind: 'item',
      graphic: 3821,
      amount: 10,
      flags: 0,
      position: { x: 901, y: 900, z: 0, direction: 0 }
    });
    expect(await c.hands.do({ verb: 'pickup', serial: 10, amount: 10 }, () => true)).toBe(false);
    expect(c.sent).toEqual(['move 9 2 all']);
  } finally {
    c.stop();
  }
});

test('a trainer reply is remembered and prevents repeated claims after restart', async () => {
  const c = client();
  c.mind.care.rode = true;
  c.session.say = () => c.world.addJournal({ serial: 20, name: 'Trainer', cliloc: 502671 });
  try {
    expect(await c.hands.do({ verb: 'claim' }, () => true)).toBe(false);
    const resumed = new Mind('ports', () => {}, traitsOf([], () => 0.5).traits);
    resumed.restore(structuredClone(c.mind.snapshot()));
    expect(resumed.care.rode).toBe(false);
    expect(resumed.care.claimAfter).toBeGreaterThan(Date.now());
  } finally {
    c.stop();
  }
});

test('stuck help follows the two offered menus and waits for an observed teleport', async () => {
  const c = client();
  const replies: number[] = [];
  c.session.requestHelp = () =>
    c.world.gumps.set('0:1', { serial: 0, id: 1, packed: false, layout: '{ button 1 1 1 1 1 0 2 }' });
  c.session.replyGump = (_serial, id, button) => {
    replies.push(button);
    c.world.gumps.clear();
    if (id === 1)
      c.world.gumps.set('0:2', {
        serial: 0,
        id: 2,
        packed: false,
        layout: '{ xmfhtmlgump 50 20 250 35 1011027 0 0 }{ button 1 1 1 1 1 0 1 }'
      });
    else c.world.position = { x: 1500, y: 1600, z: 0, direction: 0 };
  };
  try {
    expect(await c.hands.do({ verb: 'help' }, () => true)).toBe(true);
    expect(replies).toEqual([2, 1]);
    expect(c.mind.care.helpUses).toHaveLength(1);
    expect(c.mind.care.helpAfter).toBeGreaterThan(Date.now());
  } finally {
    c.stop();
  }
});

test('a navigation refusal is shared, while a cancelled walk is not a failed route', async () => {
  const c = client();
  const terrain = { pathAsync: async () => [] } as unknown as Terrain;
  const hands = new Hands(c.session, terrain);
  const failures: object[] = [];
  hands.blocked = (from, goal) => {
    failures.push(goal);
    c.mind.notice('route-failed', { from, goal, until: Date.now() + 60_000 });
  };
  try {
    expect(await hands.do({ verb: 'walk', x: 920, y: 900, range: 2 }, () => true)).toBe(false);
    expect(c.mind.reachable({ x: 920, y: 900, z: 0 })).toBe(false);
    expect(await hands.do({ verb: 'walk', x: 921, y: 900, range: 2 }, () => false)).toBe(false);
    expect(failures).toHaveLength(1);
  } finally {
    c.stop();
  }
});

test('a walk refused only for the creatures in the way is told as only that', async () => {
  const c = client();
  // The land has a way; the creatures about close it for now.
  const terrain = {
    pathAsync: async (_from: unknown, goal: { x: number; y: number }, _range: number, blocked: Set<string>) =>
      blocked.size ? [] : [{ ...goal, z: 0 }]
  } as unknown as Terrain;
  const encounter = { blocked: () => new Set(['910,900']) } as unknown as Encounter;
  const hands = new Hands(c.session, terrain, undefined, undefined, undefined, undefined, undefined, encounter);
  const failures: boolean[] = [];
  hands.blocked = (_from, _goal, hemmed) => failures.push(hemmed);
  try {
    expect(await hands.do({ verb: 'walk', x: 920, y: 900, range: 2 }, () => true)).toBe(false);
    expect(failures).toEqual([true]);
  } finally {
    c.stop();
  }
});

test('skill practice targets its pickaxe and observes a server response', async () => {
  const c = client();
  c.world.put({ serial: 3, kind: 'item', graphic: 3718, parent: 2 });
  c.session.useSkill = (id) => {
    c.sent.push(`skill ${id}`);
    c.world.target = { id: 1, ground: false, flags: 0 };
  };
  c.session.target = (aim) => {
    c.sent.push(`target ${aim?.serial}`);
    c.world.target = null;
    c.world.addJournal({ serial: 0xffffffff, name: 'System', cliloc: 500353 });
  };
  try {
    expect(await c.hands.do({ verb: 'practice', skill: 'ArmsLore', serial: 3, delay: 1000 }, () => true)).toBe(true);
    expect(c.sent).toEqual(['skill 4', 'target 3']);
    expect(c.mind.care.cooldowns.has('practice ArmsLore')).toBe(true);
  } finally {
    c.stop();
  }
});

test('an empty self-looted corpse still finishes when the contents packet arrives', async () => {
  const c = client();
  c.mind.notice('died', {});
  c.world.put({ serial: 40, kind: 'item', graphic: 8198, position: { x: 900, y: 900, z: 0, direction: 0 } });
  c.session.use = () => c.world.received.set(Opcode.containerContents, 1);
  try {
    expect(await c.hands.do({ verb: 'recover-corpse', serial: 40 }, () => true)).toBe(true);
  } finally {
    c.stop();
  }
});

test('clearing a bank slot refreshes its cached contents hover before another deposit is planned', async () => {
  const c = client();
  c.world.put({
    serial: 5,
    kind: 'item',
    graphic: 2475,
    parent: 1,
    layer: 29,
    properties: [{ cliloc: 1073841, arguments: '125\t125\t0' }]
  });
  c.world.put({ serial: 10, kind: 'item', graphic: 3934, parent: 5 });
  c.session.inspectProperties = async (serial, refresh) => {
    if (serial === 5 && refresh)
      c.world.put({
        serial: 5,
        kind: 'item',
        graphic: 2475,
        parent: 1,
        layer: 29,
        properties: [{ cliloc: 1073841, arguments: '124\t125\t0' }]
      });
  };
  try {
    expect(c.mind.bankCapacity.count).toBe(125);
    expect(await c.hands.do({ verb: 'clear-bank', serial: 10 }, () => true)).toBe(true);
    expect(c.mind.bankCapacity.count).toBe(124);
  } finally {
    c.stop();
  }
});

test('a successfully claimed mount becomes the resident mount rather than another taming target', async () => {
  const c = client();
  c.mind.care.rode = true;
  c.session.say = () => {
    c.world.put({ serial: 30, kind: 'mobile', graphic: 200, position: { x: 901, y: 900, z: 0, direction: 0 } });
    c.world.addJournal({ serial: 20, name: 'Trainer', cliloc: 1042559 });
  };
  try {
    expect(await c.hands.do({ verb: 'claim' }, () => true)).toBe(true);
    expect(c.mind.mount).toBe(30);
  } finally {
    c.stop();
  }
});

test('guard calls recheck that the criminal is still in range and the caller is innocent', async () => {
  const c = client();
  c.world.put({
    serial: 20,
    kind: 'mobile',
    graphic: 400,
    notoriety: 4,
    position: { x: 901, y: 900, z: 0, direction: 0 }
  });
  try {
    expect(await c.hands.do({ verb: 'guards', serial: 20 }, () => true)).toBe(true);
    c.world.put({ serial: 1, kind: 'mobile', graphic: 400, notoriety: 4 });
    expect(await c.hands.do({ verb: 'guards', serial: 20 }, () => true)).toBe(false);
    expect(c.sent).toEqual(['guards']);
  } finally {
    c.stop();
  }
});

test('a claim that brings out two horses rides one and stables the other', async () => {
  const c = client();
  c.mind.care.rode = true;
  const said: string[] = [];
  let targeted: number | undefined;
  c.session.say = (text: string) => {
    said.push(text);
    if (text === 'claim') {
      c.world.put({ serial: 30, kind: 'mobile', graphic: 200, position: { x: 901, y: 900, z: 0, direction: 0 } });
      c.world.put({ serial: 31, kind: 'mobile', graphic: 200, position: { x: 899, y: 900, z: 0, direction: 0 } });
      c.world.addJournal({ serial: 20, name: 'Trainer', cliloc: 1042559 });
    } else c.world.target = { serial: 7, type: 0, flags: 0 } as never;
  };
  c.session.target = ((aim: { serial: number } | null) => {
    c.world.target = null;
    targeted = aim?.serial;
    c.world.addJournal({ serial: 20, name: 'Trainer', cliloc: 1049677 });
  }) as never;
  try {
    expect(await c.hands.do({ verb: 'claim' }, () => true)).toBe(true);
    expect(c.mind.mount).toBe(30);
    expect(said).toEqual(['claim', 'stable']);
    expect(targeted).toBe(31);
  } finally {
    c.stop();
  }
});

test('a walk that tries anyway is walked whatever its memory says of the way', async () => {
  const c = client();
  const searched: string[] = [];
  const terrain = {
    pathAsync: async (_from: unknown, goal: { x: number; y: number }) => {
      searched.push(`${goal.x},${goal.y}`);
      return [];
    }
  } as unknown as Terrain;
  const hands = new Hands(c.session, terrain);
  hands.canReach = () => false;
  try {
    await hands.do({ verb: 'walk', x: 920, y: 900, range: 2 }, () => true);
    expect(searched).toEqual([]);
    await hands.do({ verb: 'walk', x: 920, y: 900, range: 2, trying: true }, () => true);
    expect(searched).toEqual(['920,900']);
  } finally {
    c.stop();
  }
});
