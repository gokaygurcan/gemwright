import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { Spawner } from '../src/spawns';
import type { HistoryEvent } from '../src/v2/history';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { type Traits, traitNames } from '../src/v2/traits';
import { type Frontier, startFrontier } from './fixtures/v2/frontier-shard';
import { type Recorded, recorded } from './fixtures/v2/resident-run';

const CAMP = { x: 152, y: 108 };
const PROMISE = { x: 142, y: 130 };
const FAR_MINE = { x: 140, y: 100 };
const TOWN_MINE = { x: 104, y: 100 };
const ATTACK = /^attack /;
const HARVEST = /^double-click my .+ > target land/;

// The shard's word, as its spawn file has it: two places east where zombies may be, among birds (half
// their spawns each, two at most). Nothing else —
// no route, no destination, no promise that either will have anything when it arrives.
const spawners: Spawner[] = [
  {
    name: 'the camp',
    x: CAMP.x,
    y: CAMP.y,
    z: 0,
    map: 'Trammel',
    range: 4,
    max: 2,
    kinds: ['zombie', 'bird'],
    mx: { zombie: 1, bird: 1 },
    delay: [5, 10]
  },
  {
    name: 'the promise',
    x: PROMISE.x,
    y: PROMISE.y,
    z: 0,
    map: 'Trammel',
    range: 4,
    max: 2,
    kinds: ['zombie', 'bird'],
    mx: { zombie: 1, bird: 1 },
    delay: [5, 10]
  }
];

const traits = (over: Partial<Traits> = {}): Traits =>
  Object.fromEntries(traitNames.map((name) => [name, over[name] ?? 0.5])) as Traits;
// A seasoned miner of some nerve: the exploration pull must come from its own reading of the
// shard's word, not from being ordered anywhere.
const minerTraits = traits({ boldness: 0.6, diligence: 0.6, patience: 0.4, greed: 0.6 });

interface Resident {
  shard: Frontier;
  mind: Mind;
  events: HistoryEvent[];
}
const resident = (born: Traits, trade: string[], skills: Record<string, number>): Resident => {
  const shard = startFrontier({ skills });
  const events: HistoryEvent[] = [];
  const mind = new Mind('resident', (event) => events.push(event), born, spawners, trade);
  // A flat, open region: the way to anywhere is the distance across it (production's walk graph).
  mind.steps = (from, to) => Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
  return { shard, mind, events };
};

async function play(
  resident: Resident,
  stopWhen: (list: Recorded[]) => boolean,
  react?: (list: Recorded[]) => void,
  capMs = 90_000
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
      shard.places,
      () => stop || Date.now() - started > capMs,
      (kind, data) => push({ resident: 'resident', at: Date.now(), kind, data })
    );
  } finally {
    stopPerception();
    shard.stop();
  }
  return recorded(events);
}

const seekId = (site: { x: number; y: number }) => `seek Zombie ${site.x},${site.y}`;
// A harvest's own record: the plan it was part of says where it stood.
const harvestIds = (list: Recorded[]) =>
  list
    .filter((entry) => entry.kind === 'plan-ended' && HARVEST.test(String(entry.data.key ?? '')))
    .map((entry) => String(entry.data.id ?? ''));

test('it works out the town seam, leaves on the shard’s word, and takes up what the frontier holds', async () => {
  const miner = resident(minerTraits, ['Mining'], { Mining: 80, Wrestling: 75, Swords: 75, Tactics: 75 });
  const list = await play(miner, (current) => {
    const far = harvestIds(current).filter((id) => id.includes(`${FAR_MINE.x},${FAR_MINE.y}`));
    const killed = current.some(
      (entry) =>
        entry.kind === 'outcome' && ATTACK.test(String(entry.data.key ?? '')) && entry.data.observed?.killed === 1
    );
    const empty = current.some(
      (entry) =>
        entry.kind === 'visited' &&
        entry.data.x === PROMISE.x &&
        entry.data.y === PROMISE.y &&
        Array.isArray(entry.data.found) &&
        !entry.data.found.includes('Zombie')
    );
    return far.length >= 2 && killed && empty;
  });

  // It worked the familiar seam first, while it gave.
  expect(harvestIds(list).filter((id) => id.includes(`${TOWN_MINE.x},${TOWN_MINE.y}`)).length).toBeGreaterThanOrEqual(
    2
  );

  // The seam ran out, and the only thing left worth doing was the trip the shard's word named.
  const leave = list.find((entry) => entry.kind === 'considered' && String(entry.data.doing ?? '').startsWith('go '));
  expect(leave).toBeDefined();
  if (!leave) throw new Error('It never left town');
  expect((leave.data.options ?? []).some((option) => HARVEST.test(option.key))).toBe(false);

  // On the way, it found ground nobody had told it of, and the finding outweighed the trip: the walk
  // was broken off where the rock was, and the rock was worked where it stood — twice over at least,
  // with nothing in between that took it elsewhere.
  expect(
    list.some(
      (entry) => entry.kind === 'plan-ended' && entry.data.id === seekId(PROMISE) && entry.data.result === 'interrupted'
    )
  ).toBe(true);
  const farMine = list.filter(
    (entry) => entry.kind === 'plan-ended' && String(entry.data.id ?? '').includes(`${FAR_MINE.x},${FAR_MINE.y}`)
  );
  expect(farMine.length).toBeGreaterThanOrEqual(2);
  const first = farMine[0];
  const last = farMine.at(-1);
  if (!first || !last) throw new Error('The far rock was never worked');
  expect(
    list.some(
      (entry) =>
        entry.index > first.index &&
        entry.index < last.index &&
        entry.kind === 'considered' &&
        String(entry.data.doing ?? '').startsWith('go ')
    )
  ).toBe(false);

  // The rock gave out, and the camp it had seen held: it met the zombie, fought it and took what it
  // carried.
  const fight = list.find((entry) => entry.kind === 'outcome' && ATTACK.test(String(entry.data.key ?? '')));
  expect(fight).toBeDefined();
  expect(fight?.data.observed?.killed).toBe(1);
  expect(fight?.data.observed?.gained?.Gold).toBeGreaterThanOrEqual(40);

  // Then the other place the shard named, at last: reached, empty when it stood there, and said so.
  expect(
    list.some(
      (entry) => entry.kind === 'plan-ended' && entry.data.id === seekId(PROMISE) && entry.data.result === 'completed'
    )
  ).toBe(true);
  expect(
    list.some(
      (entry) =>
        entry.kind === 'visited' &&
        entry.data.x === PROMISE.x &&
        entry.data.y === PROMISE.y &&
        Array.isArray(entry.data.found) &&
        !entry.data.found.includes('Zombie')
    )
  ).toBe(true);

  // And it did not go back to the empty place: nothing since sends it there again.
  const emptyAt = list.findIndex(
    (entry) => entry.kind === 'plan-ended' && entry.data.id === seekId(PROMISE) && entry.data.result === 'completed'
  );
  expect(
    list.some((entry) => entry.index > emptyAt && entry.kind === 'plan-ended' && entry.data.id === seekId(PROMISE))
  ).toBe(false);
}, 180_000);

test('what it explored and found survives into the next session', async () => {
  const miner = resident(minerTraits, ['Mining'], { Mining: 80, Wrestling: 75, Swords: 75, Tactics: 75 });
  await play(miner, (current) => {
    const killed = current.some(
      (entry) =>
        entry.kind === 'outcome' && ATTACK.test(String(entry.data.key ?? '')) && entry.data.observed?.killed === 1
    );
    const worked = current.some(
      (entry) => entry.kind === 'plan-ended' && String(entry.data.id ?? '').includes(`${FAR_MINE.x},${FAR_MINE.y}`)
    );
    return killed && worked;
  });

  // The resident logs out, and in again back in town, with its history but nothing else.
  miner.shard.place(100, 100);
  const snapshot = miner.mind.snapshot();
  miner.events = [];
  const restored = new Mind('resident', (event) => miner.events.push(event), minerTraits, spawners, ['Mining']);
  restored.restore(snapshot);
  restored.steps = (from, to) => Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));

  // A fresh mind knows only the shard's word; the returning one also carries everything it did. Both
  // are shown the same town, one after the other.
  const fresh = new Mind('resident', () => {}, minerTraits, spawners, ['Mining']);
  fresh.steps = restored.steps;
  const townWalk = (mind: Mind) =>
    mind.observe({
      resident: 'resident',
      at: 0,
      kind: 'acted',
      data: { verb: 'walk' },
      where: { x: 100, y: 100, z: 0, map: 1 }
    });
  townWalk(fresh);

  // The returning resident takes the town in through its eyes again before anything is weighed.
  miner.mind = restored;
  miner.shard.regrow();
  const session = miner.shard.session as unknown as PlayerSession;
  const stopPerception = perceive(
    session,
    'resident',
    (event) => {
      miner.events.push(event);
      restored.observe(event);
    },
    miner.shard.landAt
  );
  restored.awake = true;
  restored.acting = true;
  await Bun.sleep(50);

  // Its own history, alone, tells the ground it has walked from ground it only has the shard's word
  // for: the camp it found a zombie at is likelier ground to it than to a mind that never went there,
  // and the promise, which it never reached, means no more to it than to that fresh mind.
  const campChance = (mind: Mind) => [...mind.journeys()].find((journey) => journey.where.x === CAMP.x)?.chance ?? 0;
  const promiseOdds = (mind: Mind) =>
    [...mind.journeys()].find((journey) => journey.where.x === PROMISE.x)?.chance ?? 0;
  expect(campChance(restored)).toBeGreaterThan(campChance(fresh));
  expect(promiseOdds(restored)).toBeCloseTo(promiseOdds(fresh), 5);

  // Back on the shard, it puts the knowledge to use: the town seam is long dry, the far one filled
  // again while it slept, and the next work is the rock it found in the session before.
  const started = Date.now();
  try {
    await live(
      session,
      restored,
      miner.shard.terrain,
      miner.shard.places,
      () =>
        miner.events.some(
          (event) =>
            event.kind === 'plan-ended' &&
            String((event.data as { id?: string }).id ?? '').includes(`${FAR_MINE.x},${FAR_MINE.y}`)
        ) || Date.now() - started > 90_000,
      (kind, data) => miner.events.push({ resident: 'resident', at: Date.now(), kind, data })
    );
  } finally {
    stopPerception();
    miner.shard.stop();
  }
  expect(
    harvestIds(recorded(miner.events)).filter((id) => id.includes(`${FAR_MINE.x},${FAR_MINE.y}`)).length
  ).toBeGreaterThanOrEqual(1);
}, 240_000);
