import { expect, test } from 'bun:test';

import { creatures } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import type { Spawner } from '../src/spawns';
import type { HistoryEvent } from '../src/v2/history';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { type Traits, traitNames } from '../src/v2/traits';
import { type Recorded, recorded } from './fixtures/v2/resident-run';
import { startValley, type Valley } from './fixtures/v2/valley-shard';

const SHORE = { x: 135, y: 100, z: 0 };
// What it once found on the shore, and may again: a kind it knows from its own sight of one.
const CRAB = creatures.find((creature) => creature.type === 'HungryCoconutCrab') as (typeof creatures)[number];
const SEEK = /^go \d+,\d+: attack /;
const ATTACK = /^attack /;
const HARVEST = /^double-click my .+ > target land/;
const CRAFT = /gump-response/;
const PROBE = /^double-click my (?!Backpack)[^>]+$/;

// The shard's own spawner list, as a world's would be: a place it has been told of, where something
// of its kind may be.
const spawners: Spawner[] = [
  {
    name: 'the shore',
    x: SHORE.x,
    y: SHORE.y,
    z: SHORE.z,
    map: 'Trammel',
    range: 5,
    max: 2,
    kinds: [CRAB.type.toLowerCase()],
    mx: {},
    delay: [5, 10]
  }
];

const traits = (over: Partial<Traits> = {}): Traits =>
  Object.fromEntries(traitNames.map((name) => [name, over[name] ?? 0.5])) as Traits;

// A life before this one, carried in its history: it walked the shore once and saw the crab there,
// so the place and what may be found there are its own knowledge (ventures.ts).
const remembersTheShore = (mind: Mind) => {
  const walk = (x: number, y: number, at: number) =>
    mind.observe({ resident: 'resident', at, kind: 'acted', data: { verb: 'walk' }, where: { x, y, z: 0, map: 1 } });
  walk(SHORE.x, SHORE.y, 1_000);
  mind.observe({
    resident: 'resident',
    at: 1_500,
    kind: 'seen',
    data: {
      serial: 9001,
      kind: 'mobile',
      graphic: CRAB.bodies[0] ?? 1511,
      name: CRAB.name,
      is: [CRAB.type],
      x: SHORE.x,
      y: SHORE.y,
      z: 0
    },
    where: { x: SHORE.x, y: SHORE.y, z: 0, map: 1 }
  });
  walk(100, 100, 15_000);
};

interface Resident {
  shard: Valley;
  mind: Mind;
  events: HistoryEvent[];
}
const resident = (born: Traits, trade: string[], options: Parameters<typeof startValley>[0]): Resident => {
  const shard = startValley(options);
  const events: HistoryEvent[] = [];
  const mind = new Mind('resident', (event) => events.push(event), born, spawners, trade);
  // A flat, open world: the way to anywhere is the distance across it (production's walk graph).
  mind.steps = (from, to) => Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
  remembersTheShore(mind);
  return { shard, mind, events };
};

async function play(
  resident: Resident,
  stopWhen: (list: Recorded[]) => boolean,
  react?: (list: Recorded[]) => void,
  capMs = 45_000,
  places = resident.shard.places
): Promise<Recorded[]> {
  const { shard, mind, events } = resident;
  let stop = false;
  const push = (event: HistoryEvent) => {
    events.push(event);
    const list = recorded(events);
    react?.(list);
    if (!stop && stopWhen(list)) stop = true;
  };
  const stopPerception = perceive(
    shard.session as unknown as PlayerSession,
    'resident',
    (event) => {
      push(event);
      mind.observe(event);
    },
    shard.landAt
  );
  mind.awake = true;
  mind.acting = true;
  const started = Date.now();
  try {
    await live(
      shard.session as unknown as PlayerSession,
      mind,
      shard.terrain,
      places,
      () => stop || Date.now() - started > capMs,
      (kind, data) => push({ resident: 'resident', at: Date.now(), kind, data })
    );
  } finally {
    stopPerception();
    shard.stop();
  }
  return recorded(events);
}

const firstConsidered = (list: Recorded[], from = 0) =>
  list.find((entry) => entry.kind === 'considered' && entry.index > from);
const kinds = (entry: Recorded) =>
  new Set(
    (entry.data.options ?? []).map((option) =>
      SEEK.test(option.key)
        ? 'seek'
        : HARVEST.test(option.key)
          ? 'harvest'
          : CRAFT.test(option.key)
            ? 'craft'
            : /^sell /.test(option.key)
              ? 'sell'
              : /^double-click my .+ > target tile/.test(option.key)
                ? 'smelt'
                : option.key
    )
  );

test('the same world, the same moment, worth different things to two natures', async () => {
  const miner = resident(traits({ boldness: 0.6, diligence: 0.7, patience: 0.6 }), ['Mining'], {
    skills: { Mining: 75, Wrestling: 40, Tactics: 40 },
    ore: 4
  });
  const fighter = resident(traits({ boldness: 0.7, diligence: 0.6, patience: 0.3 }), ['Wrestling', 'Tactics'], {
    skills: { Wrestling: 75, Tactics: 75, Mining: 60 },
    ore: 4
  });

  const minerList = await play(
    miner,
    (list) => list.filter((e) => e.kind === 'outcome').length >= 2,
    undefined,
    20_000
  );
  const fighterList = await play(
    fighter,
    (list) => list.filter((e) => e.kind === 'outcome').length >= 2,
    undefined,
    20_000
  );

  const minerFirst = firstConsidered(minerList);
  const fighterFirst = firstConsidered(fighterList);
  expect(minerFirst).toBeDefined();
  expect(fighterFirst).toBeDefined();
  if (!minerFirst || !fighterFirst) throw new Error('Nobody considered anything');

  // Several ways to spend the moment were on offer to each, of different kinds.
  expect(kinds(minerFirst).size).toBeGreaterThanOrEqual(3);
  expect(kinds(fighterFirst).size).toBeGreaterThanOrEqual(3);
  // And they chose differently: the same options, ranked by their own bodies and trades.
  expect(minerFirst.data.doing).not.toBe(fighterFirst.data.doing);
  const journey = (entry: Recorded) => (entry.data.options ?? []).find((option) => SEEK.test(option.key));
  const minerJourney = journey(minerFirst);
  const fighterJourney = journey(fighterFirst);
  expect(minerJourney).toBeDefined();
  expect(fighterJourney).toBeDefined();
  if (!minerJourney || !fighterJourney) throw new Error('The shore was never weighed');
  expect(fighterJourney.rate).toBeGreaterThan(minerJourney.rate);
}, 120_000);

test('a new opportunity worth more interrupts the course, and the turn is followed through', async () => {
  const fighter = resident(traits({ boldness: 0.7, diligence: 0.6, patience: 0.3 }), ['Wrestling', 'Tactics'], {
    skills: { Wrestling: 75, Tactics: 75 }
  });
  let spawned = false;
  const list = await play(
    fighter,
    (current) => {
      const fought = current.find((entry) => entry.kind === 'outcome' && ATTACK.test(String(entry.data.key ?? '')));
      const after = fought
        ? current.find((entry) => entry.index > fought.index && entry.kind === 'considered')
        : undefined;
      return !!after || current.some((entry) => entry.kind === 'plan-ended' && entry.index > 250);
    },
    (current) => {
      // While it is on its way out of the valley, the ooze seeps out of the rock face behind it: the
      // plan in hand was chosen without it, and the next step's weighing will have to account for it.
      if (!spawned && current.some((entry) => entry.kind === 'acted' && entry.data.verb === 'walk')) {
        spawned = true;
        fighter.shard.spawnPrey();
      }
    },
    60_000
  );

  // The beast's arrival interrupted what it was at: the plan in hand ended interrupted, and the next
  // deliberation chose to fight it — worth more, by more than its patience holds it to a course.
  const fight = list.find((entry) => entry.kind === 'considered' && ATTACK.test(String(entry.data.doing ?? '')));
  expect(fight).toBeDefined();
  if (!fight) throw new Error('The beast was never chosen');
  const interrupted = list.find((entry) => entry.kind === 'plan-ended' && entry.data.result === 'interrupted');
  expect(interrupted).toBeDefined();
  const outcome = list.find((entry) => entry.kind === 'outcome' && ATTACK.test(String(entry.data.key ?? '')));
  expect(outcome).toBeDefined();
  if (!outcome) throw new Error('The fight never happened');
  expect(outcome.data.observed?.killed).toBe(1);
}, 120_000);

test('it keeps at what pays, and turns when the seam runs dry, carrying what it has learned', async () => {
  const miner = resident(traits({ boldness: 0.6, diligence: 0.7, patience: 0.6 }), ['Mining'], {
    skills: { Mining: 75, Blacksmith: 30, Wrestling: 40, Tactics: 40 },
    hammer: true
  });

  // A first life on a shop that buys only the work, so the hammer's menu can be found and worked
  // once (a paying ingot market always outbids a first, unmeasured look at a tool).
  const vendor = miner.shard.places.vendors[0];
  if (!vendor) throw new Error('The shard placed no vendor');
  const workOnly = { ...miner.shard.places, vendors: [{ ...vendor, types: ['Armorer', 'Miner'] }] };
  await play(
    miner,
    (list) => list.some((entry) => entry.kind === 'outcome' && CRAFT.test(String(entry.data.key ?? ''))),
    undefined,
    30_000,
    workOnly
  );
  const learned = miner.events.length;
  expect(miner.shard.state().crafts).toBeGreaterThanOrEqual(1);
  // The life before left it a pile of ore and a fresh pickaxe; the rock face has a dig or two left in
  // it before it runs dry.
  miner.shard.restock(8);

  // The life this test is about: the shop takes ingots as well as the work, the rock face runs dry
  // almost at once, and the beast seeps out of it while the resident works.
  let spawned = false;
  let exhausted = false;
  const digsAt = () =>
    miner.events.filter(
      (event, index) =>
        index >= learned && event.kind === 'outcome' && HARVEST.test(String((event.data as { key?: string }).key ?? ''))
    ).length;
  const list = await play(
    miner,
    (current) =>
      exhausted &&
      current.some(
        (entry) => entry.index > learned && entry.kind === 'outcome' && CRAFT.test(String(entry.data.key ?? ''))
      ) &&
      current.some(
        (entry) =>
          entry.index > learned &&
          entry.kind === 'considered' &&
          !(entry.data.options ?? []).some((option) => HARVEST.test(option.key))
      ),
    (current) => {
      if (!spawned && current.some((entry) => entry.index > learned && entry.kind === 'plan-ended')) {
        spawned = true;
        miner.shard.spawnPrey();
      }
      if (!exhausted && digsAt() >= 1) {
        exhausted = true;
        miner.shard.exhaust();
      }
    },
    60_000
  );

  // It worked the seam while it gave, dug its own ore in this life too, and turned away only when the
  // rock face itself was gone.
  const mine = list.filter(
    (entry) => entry.index > learned && entry.kind === 'outcome' && HARVEST.test(String(entry.data.key ?? ''))
  );
  expect(mine.length).toBeGreaterThanOrEqual(1);
  const lastDig = mine.at(-1)?.index ?? 0;

  // The beast was weighed more than once, and never won: with a miner's body and trade, the fight is
  // worth less than the rock face or its metal, so it kept at its own work.
  const weighed = list.filter(
    (entry) =>
      entry.index > learned &&
      entry.kind === 'considered' &&
      (entry.data.options ?? []).some((option) => ATTACK.test(option.key))
  );
  expect(weighed.length).toBeGreaterThanOrEqual(1);
  expect(weighed.every((entry) => !ATTACK.test(String(entry.data.doing ?? '')))).toBe(true);

  // The seam ran dry, and it turned to what was left: a deliberation with no rock face among its
  // choices took the best of what remained — its own metal, on its way to the work it knows.
  const after = list.find(
    (entry) =>
      entry.index > lastDig &&
      entry.kind === 'considered' &&
      !(entry.data.options ?? []).some((option) => HARVEST.test(option.key))
  );
  expect(after).toBeDefined();
  if (!after) throw new Error('Nothing was left to turn to');
  // The best of what remained (or, if nothing was better than standing still, rest).
  expect(after.data.doing === 'rest' || after.data.doing === after.data.options?.[0]?.key).toBe(true);

  // What it had learned in the first life it kept: it smelted the metal itself and took the second
  // craft through the menu it already knew — no fresh fumbling with the hammer in this life at all.
  const smelt = list.find(
    (entry) =>
      entry.index > learned &&
      entry.kind === 'outcome' &&
      /^double-click my .+ > target tile/.test(String(entry.data.key ?? ''))
  );
  const craft = list.find(
    (entry) => entry.index > learned && entry.kind === 'outcome' && CRAFT.test(String(entry.data.key ?? ''))
  );
  expect(smelt).toBeDefined();
  expect(craft).toBeDefined();
  if (!smelt || !craft) throw new Error('The metal never became work');
  expect(smelt.index).toBeLessThan(craft.index);
  expect(miner.shard.state().crafts).toBeGreaterThanOrEqual(2);
  expect(
    list.some(
      (entry) =>
        entry.index > learned &&
        entry.kind === 'considered' &&
        CRAFT.test(String(entry.data.doing ?? '')) &&
        (entry.data.options ?? []).some((option) => option.key === entry.data.doing && option.rate > 0)
    )
  ).toBe(true);
  expect(
    list.some((entry) => entry.index > learned && entry.kind === 'outcome' && PROBE.test(String(entry.data.key ?? '')))
  ).toBe(false);
}, 180_000);
