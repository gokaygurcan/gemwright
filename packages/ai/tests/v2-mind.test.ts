import { expect, test } from 'bun:test';

import { sells } from '@gemwright/common/game/rules';

import type { Outcome } from '../src/v2/beliefs';
import type { HistoryEvent } from '../src/v2/history';
import { Mind } from '../src/v2/mind';
import { traitsOf } from '../src/v2/traits';

const traits = traitsOf([], () => 0.5).traits;
const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });

// Using a pickaxe on a tile twice: the second attempt is predicted from the first, and a new mind that re-lives the
// same history predicts the same.
test('an attempt is predicted from what the same attempt brought before', () => {
  const written: HistoryEvent[] = [];
  const lived: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  const live = (e: HistoryEvent) => {
    lived.push(e);
    mind.observe(e);
  };
  const mine = (at: number, ore: number) => {
    live(event(at, 'acted', { verb: 'double-click', serial: 10 }));
    live(event(at + 100, 'acted', { verb: 'target', serial: 0, graphic: 1 }));
    live(event(at + 900, 'gained', { serial: ore, kind: 'item', graphic: 6585, amount: 2, is: ['IronOre'] }));
    live(event(at + 1000, 'acted', { verb: 'walk' }));
  };
  live(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } } }));
  live(event(0, 'gained', { serial: 10, kind: 'item', graphic: 3718, is: ['Pickaxe'] }));
  mine(1000, 20);
  mine(3000, 21);

  const key = 'double-click my Pickaxe > target tile1';
  const outcomes = written.filter((e) => e.kind === 'outcome').map((e) => e.data as { key: string; n: number });
  expect(outcomes.map((o) => [o.key, o.n])).toEqual([
    [key, 0],
    [key, 1]
  ]);
  const last = written.filter((e) => e.kind === 'predicted').at(-1)?.data;
  expect(last).toMatchObject({ key, n: 1, expect: { gained: { IronOre: 2 }, seconds: 1 } });

  const rebuilt: HistoryEvent[] = [];
  const again = new Mind('r', (e) => rebuilt.push(e), traits);
  for (const e of lived) again.observe(e);
  again.observe(event(5000, 'acted', { verb: 'double-click', serial: 10 }));
  again.observe(event(5100, 'acted', { verb: 'target', serial: 0, graphic: 1 }));
  expect(rebuilt.at(-1)?.data).toMatchObject({ key, n: 2, expect: { gained: { IronOre: 2 } } });
});

// A first purchase is foreseen from the vendor's list: the goods gained, their price in gold lost.
test('a purchase never made is foreseen from the vendor list', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  const price = sells('Weaponsmith').find((item) => item.type === 'Longsword')?.price;
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'seen', { serial: 50, kind: 'mobile', graphic: 400, is: ['Person'] }));
  mind.observe(event(0, 'changed', { serial: 50, is: ['Weaponsmith'] }));
  mind.observe(event(0, 'seen', { serial: 60, kind: 'item', graphic: 3937, parent: 51, is: ['Longsword'] }));
  mind.observe(event(1000, 'acted', { verb: 'buy', vendor: 50, items: [{ serial: 60, amount: 1 }] }));
  expect(written.at(-1)?.data).toMatchObject({
    key: 'buy Weaponsmith: 1 Longsword',
    foreseen: true,
    expect: { gained: { Longsword: 1 }, lost: { Gold: price } }
  });
});

// Paid from the bank, the gold never leaves the pack: what the vendor says is how it knows the cost.
test('a purchase paid from the bank costs the gold the vendor names', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'seen', { serial: 50, kind: 'mobile', graphic: 400, is: ['Weaponsmith'] }));
  mind.observe(event(0, 'seen', { serial: 60, kind: 'item', graphic: 3937, parent: 51, is: ['Longsword'] }));
  mind.observe(event(1000, 'acted', { verb: 'buy', vendor: 50, items: [{ serial: 60, amount: 1 }] }));
  mind.observe(event(1100, 'gained', { serial: 61, kind: 'item', graphic: 3937, is: ['Longsword'] }));
  mind.observe(
    event(1100, 'heard', {
      serial: 50,
      name: 'Bob',
      text: 'The total of thy purchase is 55 gold, which has been withdrawn from your bank account.  My thanks for the patronage.'
    })
  );
  mind.observe(event(2000, 'acted', { verb: 'walk' }));
  expect(written.find((e) => e.kind === 'outcome')?.data).toMatchObject({
    observed: { gained: { Longsword: 1 }, lost: { Gold: 55 } }
  });
});

// Moving its own things is neither gain nor loss: picked up it is held, put back among its things
// it is placed; only dropped somewhere not its own is it lost.
test('moving its own things gains and loses nothing until they leave its possession', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'revealed', { serial: 7, kind: 'item', graphic: 5141, layer: 13, is: ['PlateChest'] }));
  mind.observe(event(1000, 'acted', { verb: 'pick-up', serial: 7, amount: 1 }));
  mind.observe(event(1050, 'lost', { serial: 7 }));
  mind.observe(event(1100, 'acted', { verb: 'drop', serial: 7, container: 40 }));
  mind.observe(event(1150, 'gained', { serial: 7, kind: 'item', graphic: 5141, parent: 40, is: ['PlateChest'] }));
  mind.observe(event(2000, 'acted', { verb: 'pick-up', serial: 7, amount: 1 }));
  mind.observe(event(2050, 'lost', { serial: 7 }));
  mind.observe(event(2100, 'acted', { verb: 'drop', serial: 7, container: 0xffffffff }));
  mind.observe(event(2150, 'seen', { serial: 7, kind: 'item', graphic: 5141, x: 5, y: 5, is: ['PlateChest'] }));
  mind.observe(event(3000, 'acted', { verb: 'walk' }));
  const outcomes = written
    .filter((e) => e.kind === 'outcome')
    .map((e) => (e.data as { observed: { gained: object; lost: object } }).observed)
    .map(({ gained, lost }) => ({ gained, lost }));
  expect(outcomes).toEqual([
    { gained: {}, lost: {} },
    { gained: {}, lost: { PlateChest: 1 } }
  ]);
});

// An emote expresses; it tries nothing, so what follows is not its outcome.
test('an emote is not an attempt', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(1000, 'acted', { verb: 'speech', type: 2, text: 'stretches' }));
  mind.observe(event(1100, 'gained', { serial: 5, kind: 'item', graphic: 3821, amount: 30, is: ['Gold'] }));
  mind.observe(event(2000, 'acted', { verb: 'walk' }));
  expect(written.filter((e) => e.kind === 'outcome')).toEqual([]);
});

// Gold withdrawn from its account was already its own: what it says is the attempt, and the gold the
// banker hands over is moved, not gained.
test('withdrawing from the bank moves its gold rather than gaining it', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(1000, 'acted', { verb: 'speech', type: 192, keywords: 1, text: 'withdraw 400' }));
  mind.observe(event(1100, 'gained', { serial: 5, kind: 'item', graphic: 3821, amount: 400, is: ['Gold'] }));
  mind.observe(event(1100, 'heard', { serial: 70, name: 'Ann', cliloc: 1010005, arguments: '' }));
  mind.observe(event(2000, 'acted', { verb: 'walk' }));
  const outcome = written.find((e) => e.kind === 'outcome')?.data as {
    key: string;
    observed: { gained: object; lost: object };
  };
  expect([outcome.key, outcome.observed.gained, outcome.observed.lost]).toEqual([
    'speech withdraw 400',
    { Gold: 400 },
    { Gold: 400 }
  ]);
});

// Lifting part of a stack leaves the rest behind as a new item (ServUO LiftItemDupe): still its own.
test('lifting part of a stack gains nothing', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(
    event(0, 'revealed', { serial: 7, kind: 'item', graphic: 3617, amount: 30, parent: 40, is: ['Bandage'] })
  );
  mind.observe(event(1000, 'acted', { verb: 'pick-up', serial: 7, amount: 10 }));
  mind.observe(
    event(1010, 'gained', { serial: 8, kind: 'item', graphic: 3617, amount: 20, parent: 40, is: ['Bandage'] })
  );
  mind.observe(event(1020, 'lost', { serial: 7 }));
  mind.observe(event(1100, 'acted', { verb: 'drop', serial: 7, container: 40 }));
  mind.observe(
    event(1150, 'gained', { serial: 7, kind: 'item', graphic: 3617, amount: 10, parent: 40, is: ['Bandage'] })
  );
  mind.observe(event(2000, 'acted', { verb: 'walk' }));
  const outcome = written.find((e) => e.kind === 'outcome')?.data as
    | { observed: { gained: object; lost: object } }
    | undefined;
  expect([outcome?.observed.gained, outcome?.observed.lost]).toEqual([{}, {}]);
});

// A session that ends mid-attempt leaves its outcome unknown: nothing is learned from it.
test('an attempt cut short by sleep teaches nothing', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'seen', { serial: 3, kind: 'mobile', graphic: 1, is: ['Ogre'] }));
  mind.observe(event(1000, 'acted', { verb: 'attack', serial: 3 }));
  mind.observe(event(1050, 'skill', { skill: 'Macing', value: 50.2, before: 50 }));
  mind.observe(event(1090, 'asleep', {}));
  expect(written.filter((e) => e.kind === 'outcome')).toEqual([]);
});

// A corpse is known by who it saw die: opening a mongbat's corpse is not opening its own.
test('a corpse is named by the death that left it', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'seen', { serial: 3, kind: 'mobile', graphic: 39, is: ['Mongbat'] }));
  mind.observe(event(500, 'death', { serial: 3, corpse: 9 }));
  mind.observe(event(500, 'seen', { serial: 9, kind: 'item', graphic: 8198, flags: 0, x: 5, y: 5, is: ['Corpse'] }));
  mind.observe(event(1000, 'acted', { verb: 'double-click', serial: 9 }));
  expect(written.at(-1)?.data).toMatchObject({ key: 'double-click Corpse of Mongbat fixed' });
});

// A first cast on water is foreseen from the harvest rules: at Fishing 60 of 0-120, half a fish.
test('a harvest never tried is foreseen from the rules', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe({
    ...event(0, 'awake', { serial: 1, self: {}, skills: { Fishing: 60 } }),
    where: { x: 1, y: 1, z: 0, map: 1 }
  });
  mind.observe(event(0, 'revealed', { serial: 10, kind: 'item', graphic: 3520, layer: 1, is: ['FishingPole'] }));
  mind.observe(event(1000, 'acted', { verb: 'double-click', serial: 10 }));
  mind.observe(event(1100, 'acted', { verb: 'target', serial: 0, graphic: 6042, x: 5, y: 5, z: -5 }));
  expect(written.at(-1)?.data).toMatchObject({
    key: 'double-click my FishingPole > target tile6042',
    foreseen: true,
    expect: { gained: { Fish: 0.5 } }
  });
});

// The corpse that appears where it died is its own.
test('the corpse left where it died is its own', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  const at = (x: number) => ({ x, y: 1, z: 0, map: 1 });
  mind.observe({ ...event(0, 'awake', { serial: 1, self: {} }), where: at(1) });
  mind.observe({ ...event(500, 'died', {}), where: at(1) });
  mind.observe({
    ...event(600, 'seen', { serial: 9, kind: 'item', graphic: 8198, flags: 0, x: 1, y: 1, is: ['Corpse'] }),
    where: at(1)
  });
  mind.observe({ ...event(1000, 'acted', { verb: 'double-click', serial: 9 }), where: at(1) });
  expect(written.at(-1)?.data).toMatchObject({ key: 'double-click my Corpse' });
});

// Waking, it sees only what is there now: what was in view last session is not around it.
test('what was in view before sleep is not around it on waking', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'seen', { serial: 3, kind: 'mobile', graphic: 39, is: ['Mongbat'] }));
  mind.observe(event(500, 'asleep', {}));
  mind.observe(event(1000, 'awake', { serial: 1, self: {} }));
  mind.observe(event(2000, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  mind.observe(event(2100, 'acted', { verb: 'walk' }));
  expect(written.find((e) => e.kind === 'outcome')?.data).toMatchObject({ context: { creatures: 0 } });
});

// What an attempt trains is the skill its past attempts moved; its situation then includes how good
// the resident is at that skill now.
test('the situation includes its skill in what the attempt trains', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {}, skills: { Fishing: 40 } }));
  mind.observe(event(0, 'revealed', { serial: 10, kind: 'item', graphic: 3520, layer: 1, is: ['FishingPole'] }));
  const cast = (at: number, before: number) => {
    mind.observe(event(at, 'acted', { verb: 'double-click', serial: 10 }));
    mind.observe(event(at + 100, 'acted', { verb: 'target', serial: 0, graphic: 1 }));
    mind.observe(event(at + 500, 'skill', { skill: 'Fishing', value: before + 0.1, before }));
    mind.observe(event(at + 1000, 'acted', { verb: 'walk' }));
  };
  cast(1000, 40);
  cast(3000, 40.1);
  const contexts = written.filter((e) => e.kind === 'outcome').map((e) => (e.data as { context: object }).context);
  expect(contexts[1]).toMatchObject({ skill: 40.1 });
});

// Struck down by a creature while talking: the blows and the death are the creature's doing, not the speech's.
test('harm from a creature is credited to it, not to what the resident was doing', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 20, max: 20 } } }));
  mind.observe(event(0, 'gained', { serial: 10, kind: 'item', graphic: 5056, is: ['Bascinet'] }));
  mind.observe(event(0, 'seen', { serial: 40, kind: 'mobile', graphic: 17, is: ['Orc'] }));
  mind.observe(event(100, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  for (const at of [200, 400]) {
    mind.observe(event(at, 'animated', { serial: 40, type: 0, action: 0 }));
    mind.observe(event(at + 50, 'damage', { key: '1', value: { amount: 10 } }));
    mind.observe(event(at + 60, 'self', { health: { current: at === 200 ? 10 : 0 } }));
  }
  mind.observe(event(500, 'died', {}));
  mind.observe(event(600, 'lost', { serial: 10 }));
  mind.observe(event(700, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const outcomes = written.filter((e) => e.kind === 'outcome').map((e) => e.data as { key: string; observed: object });
  expect(outcomes.map((o) => o.key)).toEqual(['speech hail', 'struck by Orc']);
  expect(outcomes[0]?.observed).toMatchObject({ health: 0, died: 0, lost: {} });
  expect(outcomes[1]?.observed).toMatchObject({ health: -20, died: 1, lost: { Bascinet: 1 } });
});

// Killed in a fight it expected to survive, having survived the last: it grows more careful, and records why.
test('an unexpected death makes it less bold, and the drift is recorded with its cause', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 20, max: 20 } } }));
  mind.observe(event(0, 'seen', { serial: 39, kind: 'mobile', graphic: 17, is: ['Mongbat'] }));
  mind.observe(event(0, 'seen', { serial: 40, kind: 'mobile', graphic: 17, is: ['Mongbat'] }));
  mind.observe(event(50, 'acted', { verb: 'attack', serial: 39 }));
  mind.observe(event(60, 'death', { serial: 39, corpse: 41 }));
  mind.observe(event(100, 'acted', { verb: 'attack', serial: 40 }));
  mind.observe(event(200, 'animated', { serial: 40, type: 0, action: 0 }));
  mind.observe(event(250, 'damage', { key: '1', value: { amount: 20 } }));
  mind.observe(event(300, 'died', {}));
  mind.observe(event(400, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const drifted = written.find((e) => e.kind === 'drifted' && (e.data as { trait: string }).trait === 'boldness')
    ?.data as { trait: string; to: number; cause: string };
  expect(drifted).toMatchObject({ cause: 'attack Mongbat' });
  expect(drifted.to).toBeLessThan(traits.boldness);
});

// An attempt that pays better than it expected makes it greedier, recorded with its cause.
test('gold beyond what it expected makes it greedier', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 20, max: 20 } } }));
  mind.observe(event(0, 'seen', { serial: 5, kind: 'item', graphic: 3648, is: ['Chest'] }));
  for (const [at, gold] of [
    [100, 10],
    [200, 30]
  ] as const) {
    mind.observe(event(at, 'acted', { verb: 'double-click', serial: 5 }));
    mind.observe(event(at + 50, 'gained', { serial: at, kind: 'item', graphic: 3821, amount: gold, is: ['Gold'] }));
  }
  mind.observe(event(300, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const drifted = written.find((e) => e.kind === 'drifted')?.data as { trait: string; to: number; cause: string };
  expect(drifted).toMatchObject({ trait: 'greed', cause: 'double-click Chest' });
  expect(drifted.to).toBeGreaterThan(traits.greed);
});

// Woken, it has not seen inside its backpack yet: what opening it shows was its own already.
test('what opening its own container shows is not a gain', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'gained', { serial: 2, kind: 'item', graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] }));
  mind.observe(event(100, 'acted', { verb: 'double-click', serial: 2 }));
  mind.observe(event(110, 'gained', { serial: 3, kind: 'item', graphic: 5179, amount: 1, parent: 2, is: ['Maul'] }));
  mind.observe(event(200, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const outcome = written.find((e) => e.kind === 'outcome')?.data as { key: string; observed: { gained: object } };
  expect([outcome.key, outcome.observed.gained]).toEqual(['double-click my Backpack', {}]);
});

// A bandage lifted off a stack and refused as equipment drops back onto the stack: nothing gained.
test('what is lifted and merges back into its stack is not a gain', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'gained', { serial: 5, kind: 'item', graphic: 3617, amount: 10, parent: 2, is: ['Bandage'] }));
  mind.observe(event(100, 'acted', { verb: 'pick-up', serial: 5, amount: 1 }));
  mind.observe(event(101, 'lost', { serial: 5 }));
  mind.observe(event(102, 'acted', { verb: 'equip', serial: 5, layer: 0, mobile: 1 }));
  mind.observe(event(103, 'gained', { serial: 6, kind: 'item', graphic: 3617, amount: 9, parent: 2, is: ['Bandage'] }));
  mind.observe(event(104, 'changed', { serial: 6, amount: 10 }));
  mind.observe(event(200, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const outcome = written.find((e) => e.kind === 'outcome')?.data as { observed: { gained: object; lost: object } };
  expect([outcome.observed.gained, outcome.observed.lost]).toEqual([{}, {}]);
});

// Once on an empty rock is not the last word: curious, it still hopes for what the wiki says mining
// brings, as much more as it is curious and as little as it has tried.
test('a curious mind hopes for more from what it has tried only a little', () => {
  const appraise = (curiosity: number) => {
    const mind = new Mind('r', () => {}, { ...traits, curiosity });
    mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } } }));
    mind.observe(event(0, 'gained', { serial: 10, kind: 'item', graphic: 3718, is: ['Pickaxe'] }));
    mind.observe(event(100, 'acted', { verb: 'double-click', serial: 10 }));
    mind.observe(event(200, 'acted', { verb: 'target', serial: 0, graphic: 1 }));
    mind.observe(event(3200, 'acted', { verb: 'walk' }));
    return mind.appraise('double-click my Pickaxe > target tile1', { gained: { IronOre: 1 } })?.value ?? 0;
  };
  expect(appraise(1)).toBeGreaterThan(appraise(0));
});

// Getting off her horse: the mount she rode leaves her as a horse standing where she is. That horse is
// hers, and nothing was lost.
test('the horse left where it dismounted is its own', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  const here = { x: 5, y: 5, z: 0, map: 1 };
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe({
    ...event(0, 'revealed', { serial: 20, kind: 'item', graphic: 16033, layer: 25, parent: 1, is: [] }),
    where: here
  });
  mind.observe({ ...event(100, 'acted', { verb: 'double-click', serial: 1 }), where: here });
  mind.observe({
    ...event(102, 'seen', { serial: 30, kind: 'mobile', graphic: 228, x: 5, y: 5, z: 0, is: ['Horse'] }),
    where: here
  });
  mind.observe({ ...event(103, 'lost', { serial: 20, layer: 25, parent: 1 }), where: here });
  mind.observe({ ...event(500, 'acted', { verb: 'speech', type: 0, text: 'hail' }), where: here });
  expect(mind.call(30)).toBe('my Horse');
  expect(mind.mount).toBe(30);
  const outcome = written.find((e) => e.kind === 'outcome')?.data as { observed: { lost: object } };
  expect(outcome.observed.lost).toEqual({});
});

// Killing a mongbat and taking the gold from its corpse: the gold is what the fight brought.
test('what it loots from its kill is what the fight brought', () => {
  const written: HistoryEvent[] = [];
  const mind = new Mind('r', (e) => written.push(e), traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } } }));
  mind.observe(
    event(0, 'revealed', { serial: 2, kind: 'item', graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] })
  );
  mind.observe(event(0, 'seen', { serial: 40, kind: 'mobile', graphic: 39, x: 3, y: 3, is: ['Mongbat'] }));
  mind.observe(event(100, 'acted', { verb: 'attack', serial: 40 }));
  mind.observe(event(900, 'death', { serial: 40, corpse: 50 }));
  mind.observe(event(901, 'seen', { serial: 50, kind: 'item', graphic: 8198, x: 3, y: 3, is: ['Corpse'] }));
  mind.observe(event(1000, 'acted', { verb: 'double-click', serial: 50 }));
  mind.observe(event(1100, 'seen', { serial: 60, kind: 'item', graphic: 3821, amount: 12, parent: 50, is: ['Gold'] }));
  mind.observe(event(1200, 'acted', { verb: 'pick-up', serial: 60, amount: 12 }));
  mind.observe(event(1300, 'acted', { verb: 'drop', serial: 60, container: 2 }));
  mind.observe(event(1301, 'gained', { serial: 60, kind: 'item', graphic: 3821, amount: 12, parent: 2, is: ['Gold'] }));
  mind.observe(event(2000, 'acted', { verb: 'speech', type: 0, text: 'hail' }));
  const outcomes = written.filter((e) => e.kind === 'outcome').map((e) => e.data as { key: string; observed: Outcome });
  expect(outcomes.map((o) => o.key)).toEqual(['attack Mongbat']);
  expect(outcomes[0]?.observed).toMatchObject({ killed: 1, gained: { Gold: 12 } });
});

// Carrying gold is risking it: putting it in the bank is worth what it would otherwise stand to lose
// before it is next back, more so the more it carries and the more timid it is.
test('a deposit is worth what it protects', () => {
  const protect = (boldness: number, gold: number) => {
    const mind = new Mind('r', () => {}, { ...traits, boldness });
    mind.observe(event(0, 'awake', { serial: 1, self: {} }));
    mind.observe(event(0, 'gained', { serial: 9, kind: 'item', graphic: 3821, amount: gold, parent: 2, is: ['Gold'] }));
    return mind.deposit([9]);
  };
  expect(protect(0.5, 1000)).toBeGreaterThan(protect(0.5, 100));
  expect(protect(0.1, 1000)).toBeGreaterThan(protect(0.9, 1000));
  expect(protect(0.5, 1000)).toBeGreaterThan(0);
});

// Hovered, a pile it took for iron ore shows it is valorite: from then on it is valorite ore.
test('what the hover shows renames its own things', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(0, 'gained', { serial: 9, kind: 'item', graphic: 6584, amount: 3, parent: 2, is: ['IronOre'] }));
  mind.observe(
    event(10, 'changed', {
      serial: 9,
      properties: [
        { cliloc: 1026583, arguments: '' },
        { cliloc: 1053101, arguments: '' }
      ],
      is: ['ValoriteOre']
    })
  );
  expect(mind.belongings().get(9)?.name).toBe('ValoriteOre');
});

test('waking retains known bank supplies but clears carried inventory until observed again', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(1, 'revealed', { serial: 5, kind: 'item', layer: 29, parent: 1, is: ['BankBox'] }));
  mind.observe(event(2, 'revealed', { serial: 10, kind: 'item', parent: 5, amount: 43, is: ['IronIngot'] }));
  mind.observe(event(3, 'revealed', { serial: 11, kind: 'item', parent: 1, is: ['BattleAxe'] }));
  mind.observe(event(4, 'awake', { serial: 1, self: {} }));
  expect(mind.belongings().get(10)).toEqual({ name: 'IronIngot', amount: 43 });
  expect(mind.banked(10)).toBe(true);
  expect(mind.belongings().has(11)).toBe(false);
});

test('bank balance is spending power, survives a checkpoint, and is debited by confirmed bank charges', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(event(1, 'heard', { serial: 20, cliloc: 1042759, arguments: '109' }));
  mind.observe(event(2, 'revealed', { serial: 5, kind: 'item', layer: 29, parent: 1, is: ['BankBox'] }));
  mind.observe(event(3, 'revealed', { serial: 10, kind: 'item', parent: 5, amount: 109, is: ['Gold'] }));
  expect(mind.funds()).toBe(109);
  const resumed = new Mind('r', () => {}, traits);
  resumed.restore(structuredClone(mind.snapshot()));
  resumed.observe(event(4, 'awake', { serial: 1, self: {} }));
  expect(resumed.funds()).toBe(109);
  resumed.observe(event(5, 'acted', { verb: 'buy', vendor: 20, items: [] }));
  resumed.observe(
    event(6, 'heard', {
      serial: 20,
      text: 'The total of thy purchase is 22 gold, which has been withdrawn from your bank account.'
    })
  );
  expect(resumed.funds()).toBe(87);
});
