import { expect, test } from 'bun:test';

import type { Spawner } from '../src/spawns';
import { type Steps, Ventures } from '../src/ventures';

const spawner = (x: number, kinds: string[], delay: [number, number] = [5, 10]): Spawner => ({
  name: 's',
  x,
  y: 0,
  z: 0,
  map: 'Trammel',
  range: 10,
  max: 1,
  kinds,
  mx: {},
  delay
});
const at = (x: number) => ({ x, y: 0, z: 0, map: 1 });
// Ways as the land has them, here along a straight shore: as many steps as tiles apart, and none
// past x 1000 (across water).
const along: Steps = (from, to) => (to.x > 1000 ? undefined : Math.abs(to.x - from.x));
// Passing within sight of a spawner, seeing what `seen` says there, and being elsewhere later (too
// long after to count as walking pace).
const pass = (ventures: Ventures, x: number, when: number, seen?: string) => {
  ventures.walk(when, at(x - 5));
  if (seen) ventures.saw(seen, x, 0);
  ventures.walk(when + 3000, at(x + 200));
};

// Walking 2 tiles a second, it can go back to a fishing spot, to a mongbat spawn it has passed, or
// to one it has only the shard's word for, each at the steps of the way there.
test('ventures go where something can be done again, at its walking pace along the way', () => {
  const ventures = new Ventures([spawner(100, ['mongbat']), spawner(40, ['mongbat'])]);
  ventures.walk(0, at(0));
  ventures.walk(1000, at(2));
  pass(ventures, 100, 3000, 'Mongbat');
  ventures.remember('double-click my FishingPole > target tile6042', at(20));
  ventures.remember('pick-up PlateChest > drop my Backpack', at(30));
  expect([...ventures.ahead(at(0), new Set(), () => true, along)]).toEqual([
    { key: 'double-click my FishingPole > target tile6042', where: at(20), walk: 10, chance: 1 },
    { key: 'attack Mongbat', where: { x: 100, y: 0, z: 0, map: 1 }, walk: 50, chance: 1 },
    { key: 'attack Mongbat', where: at(40), walk: 20, chance: 1 }
  ]);
});

// A spawner it has never come within sight of is somewhere the shard says something is: it goes on
// that word, at the odds the spawner's own counts give (one kind, always there when full).
test("a spawner never seen is somewhere to go, on the shard's word", () => {
  const ventures = new Ventures([spawner(100, ['mongbat']), spawner(300, ['mongbat'])]);
  pass(ventures, 100, 0, 'Mongbat');
  expect([...ventures.ahead(at(0), new Set(), () => true, along)].map((v) => [v.where.x, v.chance])).toEqual([
    [100, 1],
    [300, 1]
  ]);
});

// One across water, with no way there, is not somewhere to go, however well it is known.
test('a spawner with no way to it is not somewhere to go', () => {
  const ventures = new Ventures([spawner(1100, ['mongbat'])]);
  pass(ventures, 1100, 0, 'Mongbat');
  expect([...ventures.ahead(at(0), new Set(), () => true, along)]).toEqual([]);
});

// Without a way to measure walks it goes nowhere: it never guesses one as the crow flies.
test('with no way to measure the walk, nowhere is somewhere to go', () => {
  const ventures = new Ventures([spawner(100, ['mongbat'])]);
  pass(ventures, 100, 0, 'Mongbat');
  expect([...ventures.ahead(at(0), new Set())]).toEqual([]);
});

// A spawner says what may be there: walking past one and seeing its kind makes it likelier, walking
// past and seeing nothing makes it less likely.
test('a spawner is trusted as far as walking past it has borne out', () => {
  const ventures = new Ventures([spawner(100, ['mongbat'], [0, 0]), spawner(300, ['ettin'], [0, 0])]);
  pass(ventures, 100, 0, 'Mongbat/StrongMongbat');
  pass(ventures, 300, 5000);
  const chances = Object.fromEntries(
    [...ventures.ahead(at(600), new Set(), () => true, along)].map((v) => [v.key, v.chance])
  );
  expect(chances).toEqual({ 'attack Mongbat': 1, 'attack Ettin': 2 / 3 });
});

// Seen empty, a spawner fills again over its own delay (here 5 to 15 minutes, 10 on average): just
// after, hardly anything to find there; half way, half as likely; after it, as likely as ever,
// counting the walk there.
test('a spawner seen empty fills again over its spawn delay', () => {
  const ventures = new Ventures([spawner(100, ['mongbat'], [5, 15])]);
  pass(ventures, 100, 0);
  const chance = (now: number) => {
    ventures.walk(now, at(400));
    return [...ventures.ahead(at(400), new Set(), () => true, along)][0]?.chance ?? 0;
  };
  const trusted = 2 / 3;
  // Left at 3 seconds; 300 steps at 2.5 a second is two minutes on the way.
  expect(chance(10_000)).toBeCloseTo((trusted * (10_000 + 120_000 - 3000)) / 600_000, 5);
  expect(chance(183_000)).toBeCloseTo(trusted * 0.5, 5);
  expect(chance(700_000)).toBeCloseTo(trusted, 5);
});

// A spawner of people is borne out by seeing a person there: their names are not what it sees.
test('a person seen at a spawner of people is a find', () => {
  const ventures = new Ventures([spawner(100, ['naturalist'])]);
  pass(ventures, 100, 0, 'Person');
  expect([...ventures.ahead(at(400), new Set(), () => true, along)].map((v) => [v.key, v.chance])).toEqual([
    ['attack Naturalist', 1]
  ]);
});

// Each time it passes a spawner, what it found there is told, so its trust in places can be seen.
test('each visit to a spawner is told with what it found', () => {
  const visits: object[] = [];
  const ventures = new Ventures([spawner(100, ['mongbat'])], (visit) => visits.push(visit));
  pass(ventures, 100, 0, 'Mongbat');
  expect(visits).toEqual([{ x: 100, y: 0, kinds: ['Mongbat'], found: ['Mongbat'] }]);
});

// Standing by a mongbat spawn and seeing none, there is no going there: only to the one further off.
test('a spawner in sight is not somewhere to go', () => {
  const ventures = new Ventures([spawner(100, ['mongbat']), spawner(300, ['mongbat'])]);
  pass(ventures, 300, 0, 'Mongbat');
  pass(ventures, 100, 10_000, 'Mongbat');
  ventures.walk(20_000, at(95));
  expect([...ventures.ahead(at(95), new Set(), () => true, along)].map((v) => v.where.x)).toEqual([300]);
});

// A place it dug with a shovel it has since worn out, or one it stands at already: nowhere to go.
test('a remembered place is not somewhere to go without the tool, or when already there', () => {
  const ventures = new Ventures([]);
  ventures.remember('double-click my Shovel > target land241', at(100));
  const keys = (x: number, owns: string[]) =>
    [...ventures.ahead(at(x), new Set(), (name) => owns.includes(name), along)].map((v) => v.key);
  expect(keys(0, ['Shovel'])).toEqual(['double-click my Shovel > target land241']);
  expect(keys(0, [])).toEqual([]);
  expect(keys(99, ['Shovel'])).toEqual([]);
});

// Kept to its cities, it never measures the way to a place outside them: every measured walk costs a
// search through the land, and one it may not take is wasted.
test('a place outside where it may go is never measured', () => {
  const ventures = new Ventures([spawner(100, ['mongbat']), spawner(300, ['mongbat'])]);
  ventures.remember('double-click my FishingPole > target tile6042', at(500));
  const measured: number[] = [];
  const counting: Steps = (from, to) => {
    measured.push(to.x);
    return along(from, to);
  };
  const within = (p: { x: number }) => p.x < 200;
  expect([...ventures.ahead(at(0), new Set(), () => true, counting, within)].map((v) => v.where.x)).toEqual([100]);
  expect(measured).toEqual([100]);
});

// A spawner of many kinds says how many of each it keeps (ServUO XmlSpawner MX, out of MaxCount): one
// mongbat place among cows and birds is not a mongbat place, and seeing a cow there is no mongbat.
test('each kind of a mixed spawner is weighed by its own share of the spawns and its own finds', () => {
  const mixed: Spawner = {
    ...spawner(100, ['mongbat', 'bull', 'bird']),
    max: 4,
    mx: { mongbat: 1, bull: 4, bird: 5 }
  };
  const ventures = new Ventures([mixed]);
  const chances = () =>
    Object.fromEntries([...ventures.ahead(at(400), new Set(), () => true, along)].map((v) => [v.key, v.chance]));
  // At least one of four spawns a mongbat when one in ten is: 1 - 0.9^4.
  const mongbat = 1 - 0.9 ** 4;
  expect(chances()['attack Mongbat']).toBeCloseTo(mongbat, 5);
  pass(ventures, 100, 0, 'Bull');
  // Passing it and seeing a bull and no mongbat: likelier bulls, less likely mongbats.
  expect(chances()['attack Mongbat']).toBeLessThan(mongbat);
  expect(chances()['attack Bull']).toBeGreaterThan(1 - 0.6 ** 4);
});

// One spawn each delay, of a kind as often as its share: a kind seen gone comes back over its own
// share of the spawns, not over one delay.
test('a kind seen gone comes back at the pace the spawner makes that kind', () => {
  const mixed: Spawner = { ...spawner(100, ['mongbat', 'bird'], [10, 10]), max: 1, mx: { mongbat: 1, bird: 9 } };
  const ventures = new Ventures([mixed]);
  pass(ventures, 100, 0, 'Bird');
  const chance = (now: number) => {
    ventures.walk(now, at(400));
    return (
      [...ventures.ahead(at(400), new Set(), () => true, along)].find((v) => v.key === 'attack Mongbat')?.chance ?? 0
    );
  };
  // A mongbat is one spawn in ten, each ten minutes apart: a hundred minutes to come back.
  const later = chance(3000 + 50 * 60_000 - 120_000);
  const full = chance(3000 + 200 * 60_000);
  expect(later).toBeCloseTo(full / 2, 2);
});

// What its hands learned they cannot walk to from here, its deliberation never offers: a way that
// failed stays failed until the time it was given runs out.
test('a place its walks failed to reach is not somewhere to go until that failure has run out', async () => {
  const { Mind } = await import('../src/mind');
  const { traitsOf } = await import('../src/traits');
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [
    spawner(100, ['mongbat']),
    spawner(300, ['mongbat'])
  ]);
  mind.steps = along;
  mind.observe({ resident: 'r', at: 0, kind: 'acted', data: { verb: 'walk' }, where: at(0) });
  const places = () => [...mind.journeys()].map((journey) => journey.where.x);
  expect(places().sort()).toEqual([100, 300]);
  mind.notice('route-failed', { from: at(0), goal: { x: 100, y: 0, z: 0 }, until: Date.now() + 60_000 });
  expect(places()).toEqual([300]);
});
