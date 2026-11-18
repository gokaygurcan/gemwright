import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { moongateList } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { type Link, parseTeleporters } from '../src/links';
import { Mind } from '../src/mind';
import { choices } from '../src/planning';
import { Reach } from '../src/reach';
import { readShardWorld } from '../src/spawns';
import { Terrain } from '../src/terrain';
import { traitsOf } from '../src/traits';
import { WalkGraph } from '../src/walk-graph';
import { buildWalkGraph, type Spot, spotKey, steps } from '../src/walk-graph-build';
import { useWalkGraph } from '../src/walk-graph-store';
import { seeing } from './fixtures/mind-sync';

// Against the real map: the client's map files (files/) and a shard's world files, both kept out of
// the repository; without them there is nothing to test against.
const files = join(import.meta.dir, '../../../files');
const world = join(import.meta.dir, '../../../test-shards/servuo/.gemwright/vps/world');
const available = existsSync(join(files, 'statics1.mul')) && existsSync(join(world, 'teleporters.csv'));

describe.skipIf(!available)('walk graph on the real map', () => {
  const terrain = available ? Terrain.shared(files, 1) : (undefined as unknown as Terrain);
  const links: Link[] = available ? parseTeleporters(readFileSync(join(world, 'teleporters.csv'), 'utf8')) : [];
  const closed = new Set(links.map((l) => l.from.x * 4096 + l.from.y));
  const gates = moongateList as Record<string, { x: number; y: number; z: number }>;
  const stand = (x: number, y: number): Spot | undefined => {
    const z = terrain.standingZ(x, y, terrain.cell(x, y).land.z);
    return z === undefined || closed.has(x * 4096 + y) ? undefined : { x, y, z };
  };
  let seed = 20261111;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const anywhere = (x0: number, y0: number, width: number, height: number) => {
    for (;;) {
      const spot = stand(x0 + 2 + Math.floor(random() * (width - 4)), y0 + 2 + Math.floor(random() * (height - 4)));
      if (spot) return spot;
    }
  };
  // The exact fewest steps on foot, tile by tile, inside a box: the truth a graph answer is held to.
  const walked = (
    from: Spot,
    to: Spot,
    box: { x: number; y: number; width: number; height: number },
    blocked: ReadonlySet<number> = closed
  ) => {
    const far = new Map([[spotKey(from), 0]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i] as Spot;
      if (at.x === to.x && at.y === to.y) return far.get(spotKey(at)) ?? 0;
      for (const next of steps(terrain, at, blocked)) {
        const out = next.x < box.x || next.y < box.y || next.x >= box.x + box.width || next.y >= box.y + box.height;
        if (out || far.has(spotKey(next))) continue;
        far.set(spotKey(next), (far.get(spotKey(at)) ?? 0) + 1);
        queue.push(next);
      }
    }
    return undefined;
  };
  // A walk between two near spots (a leg of a route), tile by tile; `onto` lets it end on a
  // teleporter's tile, which a walk otherwise never steps on.
  const reachable = (from: Spot, to: { x: number; y: number }, onto = false) => {
    const box = { x: Math.min(from.x, to.x) - 64, y: Math.min(from.y, to.y) - 64, width: 0, height: 0 };
    box.width = Math.abs(from.x - to.x) + 128;
    box.height = Math.abs(from.y - to.y) + 128;
    if (!onto) {
      const end = stand(to.x, to.y) ?? { ...to, z: from.z };
      return (
        walked(from, end, box) !== undefined || walked(from, { ...end, z: (to as Spot).z ?? end.z }, box) !== undefined
      );
    }
    // Onto the teleporter from a tile beside it, at the height one walks up to it at.
    for (const [dx, dy] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1]
    ] as const) {
      const x = to.x + dx;
      const y = to.y + dy;
      for (const level of [(to as Spot).z, from.z, terrain.cell(x, y).land.z]) {
        const z = level === undefined ? undefined : terrain.standingZ(x, y, level);
        if (z !== undefined && walked(from, { x, y, z }, box) !== undefined) return true;
      }
    }
    return false;
  };

  // Every route a query gives must be one a player can follow: each walk leg walkable from where
  // the last one left it, each teleporter stepped onto and arrived from, each gate ending at the
  // gate it names.
  const follows = (from: Spot, route: NonNullable<ReturnType<WalkGraph['route']>>) => {
    let at: Spot = from;
    for (const leg of route.legs) {
      if (leg.kind === 'teleport') {
        if (!reachable(at, leg, true)) return `no walk onto the teleporter at ${leg.x},${leg.y}`;
        const link = links.find((l) => l.from.x === leg.x && l.from.y === leg.y && l.from.z === leg.z);
        if (!link) return `no teleporter at ${leg.x},${leg.y}`;
        const z = terrain.standingZ(link.to.x, link.to.y, link.to.z);
        at = { x: link.to.x, y: link.to.y, z: z ?? link.to.z };
        continue;
      }
      if (!reachable(at, leg)) return `no walk from ${at.x},${at.y} to ${leg.x},${leg.y}`;
      if (leg.kind === 'gate') {
        const gate = gates[leg.to];
        if (!gate) return `no gate ${leg.to}`;
        at = stand(gate.x, gate.y) ?? { ...gate };
        continue;
      }
      at = leg;
    }
    return undefined;
  };

  let graph: WalkGraph;
  test('the whole of Trammel builds once and is kept', async () => {
    const cache = join(tmpdir(), 'gemwright-walk-graph');
    mkdirSync(cache, { recursive: true });
    graph = new WalkGraph(await useWalkGraph(cache, terrain, files, links, gates), terrain, closed);
    expect(graph.size).toBeGreaterThan(100_000);
  }, 600_000);

  // The builder misses no way on foot: in three pieces of land (a town and its coast, Britain, and
  // a stretch of dungeons), a graph of that piece alone joins exactly the spots the tiles do, never
  // in fewer steps than the tiles allow, and never so many more that the way stops making sense.
  for (const box of [
    { name: 'New Haven', x: 3200, y: 2400, width: 640, height: 512 },
    { name: 'Britain', x: 1280, y: 1472, width: 512, height: 544 },
    { name: 'dungeons', x: 5120, y: 0, width: 512, height: 512 }
  ])
    test(`in ${box.name}, it joins exactly the spots the tiles join`, async () => {
      const local = new WalkGraph(await buildWalkGraph(terrain, [], {}, 10, box, 32, async () => {}), terrain);
      for (let i = 0; i < 120; i++) {
        const a = anywhere(box.x, box.y, box.width, box.height);
        const b = anywhere(box.x, box.y, box.width, box.height);
        // That graph knows no teleporters, so neither does its truth.
        const truth = walked(a, b, box, new Set());
        const found = local.route(a, b);
        expect({ a, b, joined: found !== undefined }).toEqual({ a, b, joined: truth !== undefined });
        if (truth === undefined || !found) continue;
        expect(found.steps).toBeGreaterThanOrEqual(truth);
        expect(found.steps).toBeLessThanOrEqual(Math.max(truth * 1.25, truth + 16));
      }
    }, 600_000);

  const banks = available
    ? (readShardWorld(world)?.spawners ?? [])
        .filter((s) => s.map === 'Trammel' && s.kinds.some((k) => /banker/i.test(k)))
        .flatMap((s) => stand(s.x, s.y) ?? [])
    : [];
  const bankNear = (x: number, y: number) =>
    banks.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a));
  const britain = () => bankNear(1432, 1688);
  const moonglow = () => bankNear(4471, 1157);
  const trinsic = () => bankNear(1813, 2825);
  const into = (l: Link) => l.from.x < 5120 && l.to.x >= 5120;
  const within = (l: Link) => l.from.x >= 5120 && l.to.x >= 5120;
  // Where a teleporter puts you, or a step off it when that is another teleporter's tile (a two-way
  // pair): where one stands after arriving.
  const arrival = (l: Link): Spot => {
    const at = { x: l.to.x, y: l.to.y, z: terrain.standingZ(l.to.x, l.to.y, l.to.z) ?? l.to.z };
    if (!closed.has(at.x * 4096 + at.y)) return at;
    return steps(terrain, at, closed)[0] ?? at;
  };

  test('city to city on foot: Britain to Trinsic, gates closed, walking only', () => {
    const route = graph.route(britain(), trinsic(), () => false);
    expect(route).toBeDefined();
    expect(route?.legs.some((l) => l.kind === 'gate')).toBe(false);
    expect(follows(britain(), route as NonNullable<typeof route>)).toBeUndefined();
  });

  test('city to city across water: Moonglow is reached by moongate, and not at all on foot', () => {
    const route = graph.route(britain(), moonglow());
    expect(route?.legs.some((l) => l.kind === 'gate')).toBe(true);
    expect(follows(britain(), route as NonNullable<typeof route>)).toBeUndefined();
    expect(graph.route(britain(), moonglow(), () => false)).toBeUndefined();
  });

  test('city to dungeon and back: every dungeon entrance from Britain, through its teleporter', () => {
    for (const link of links.filter(into)) {
      const inside = arrival(link);
      const there = graph.route(britain(), inside);
      if (!there) continue;
      expect(there.legs.some((l) => l.kind === 'teleport' || l.kind === 'gate')).toBe(true);
      expect(follows(britain(), there)).toBeUndefined();
      const back = graph.route(inside, britain());
      if (back) expect(follows(inside, back)).toBeUndefined();
    }
    const entered = links.filter(into).filter((l) => graph.route(britain(), arrival(l)));
    expect(entered.length).toBeGreaterThan(links.filter(into).length / 2);
  }, 600_000);

  test('dungeon level to dungeon level: every level teleporter, from where the one before put you', () => {
    let followed = 0;
    for (const link of links.filter(within)) {
      const entry = links
        .filter(into)
        .map(arrival)
        .find((spot) => graph.route(spot, { ...link.from }) !== undefined);
      if (!entry) continue;
      const route = graph.route(entry, arrival(link));
      expect(route).toBeDefined();
      expect(follows(entry, route as NonNullable<typeof route>)).toBeUndefined();
      followed++;
    }
    expect(followed).toBeGreaterThan(20);
  }, 600_000);

  test('landmark to landmark: every bank and gate to every other, followable, in a few milliseconds', () => {
    const gateSpots = Object.values(gates).flatMap((g) => {
      const z = terrain.standingZ(g.x, g.y, g.z) ?? terrain.standingZ(g.x, g.y, terrain.cell(g.x, g.y).land.z);
      return z === undefined ? [] : [{ x: g.x, y: g.y, z }];
    });
    // Every gate reaches every other: a gate is a step from the next.
    for (const a of gateSpots) for (const b of gateSpots) if (a !== b) expect(graph.route(a, b)).toBeDefined();
    const marks = [...banks, ...gateSpots];
    const times: number[] = [];
    let checked = 0;
    for (const a of marks)
      for (const b of marks) {
        if (a === b) continue;
        const started = performance.now();
        const route = graph.route(a, b);
        times.push(performance.now() - started);
        if (route && checked++ % 7 === 0) expect(follows(a, route)).toBeUndefined();
      }
    times.sort((x, y) => x - y);
    // The bound agreed for the whole map (about 5 ms measured): a long way crosses many cells.
    expect(times[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(8);
  }, 600_000);

  // An island with no moongate (Nujel'm) is reached by no route, from anywhere.
  test('an island with no gate is not reached on foot', () => {
    expect(graph.route(britain(), bankNear(3764, 1317))).toBeUndefined();
  });

  test('random spot to random spot anywhere: answered in a few milliseconds, every way followable', () => {
    const times: number[] = [];
    let joined = 0;
    for (let i = 0; i < 400; i++) {
      const a = anywhere(1, 1, 7160, 4090);
      const b = anywhere(1, 1, 7160, 4090);
      const started = performance.now();
      const route = graph.route(a, b, undefined, i + 1);
      times.push(performance.now() - started);
      if (!route) continue;
      joined++;
      if (i % 20 === 0) expect(follows(a, route)).toBeUndefined();
    }
    times.sort((x, y) => x - y);
    expect(joined).toBeGreaterThan(100);
    // The bound agreed for two places never visited before (about 13 ms measured): each end walks its
    // own cell once.
    expect(times[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(20);
  }, 600_000);

  // In New Haven, having passed both the graveyard's zombie spawn and one on the mainland far off
  // (both empty then), the only zombie trip it weighs is the near one: its places are walked
  // nearest-first, and the far reaches of the shard's word are never weighed while the graveyard's
  // spawn still promises something. Measuring a known spawner from where it stands takes a few
  // milliseconds.
  test('in New Haven, a zombie trip goes to New Haven, not across the map', () => {
    const spawners = readShardWorld(world)?.spawners ?? [];
    const home = { x: 3460, y: 2640, z: 0, map: 1 };
    const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, spawners, ['Macing', 'Tactics']);
    mind.observe({
      resident: 'r',
      at: 0,
      where: home,
      kind: 'awake',
      data: { serial: 1, self: { health: { current: 100, max: 100 } }, skills: { Macing: 80, Tactics: 80 } }
    });
    const visit = (x: number, y: number, at: number) => {
      mind.observe({ resident: 'r', at, where: { x, y, z: 0, map: 1 }, kind: 'acted', data: { verb: 'walk' } });
      mind.observe({ resident: 'r', at: at + 5000, where: home, kind: 'acted', data: { verb: 'walk' } });
    };
    visit(3407, 2645, 0);
    visit(1122, 725, 10_000);
    // Both spawns have refilled.
    mind.observe({ resident: 'r', at: 1_200_000, where: home, kind: 'acted', data: { verb: 'walk' } });
    const reach = new Reach(graph, terrain);
    mind.steps = reach.steps;
    const journeys = [...mind.journeys()].filter((journey) => journey.key === 'attack Zombie');
    // Every zombie spawn the shard names is somewhere it could go; the two it has walked past are the
    // ones it knows anything about. It saw the same of both, so the shard's word on each tells them
    // apart: New Haven's graveyard spawns mostly zombies, the far spawner few.
    const visited = journeys.filter((journey) => journey.where.x === 3407 || journey.where.x === 1122);
    expect(visited).toHaveLength(2);
    const near = visited.find((journey) => journey.where.x === 3407)?.chance ?? 0;
    const far = visited.find((journey) => journey.where.x === 1122)?.chance ?? 0;
    expect(near).toBeGreaterThan(far);
    const started = performance.now();
    const session = {
      world: { serial: 1, position: { ...home, direction: 0 }, entities: new Map() }
    } as unknown as PlayerSession;
    const zombieTrips = choices(seeing(mind, session), undefined, new Set(), { bankers: [], vendors: [] })
      .filter((o) => o.key.startsWith('go ') && o.key.endsWith('attack Zombie'))
      .map((o) => o.key);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(zombieTrips).toEqual(['go 3407,2652: attack Zombie']);
    const times: number[] = [];
    for (const s of spawners.filter((p) => p.map === 'Trammel').slice(0, 300)) {
      const t0 = performance.now();
      reach.steps(home, s);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(5);
  }, 600_000);

  test('estimates and follows the same moongate route across water', () => {
    const reach = new Reach(graph, terrain);
    const from = britain();
    const to = moonglow();
    expect(reach.steps(from, to)).toBeGreaterThan(0);
    const route = reach.route(from, to, 1);
    expect(route?.legs.some((leg) => leg.kind === 'gate')).toBe(true);
    expect(follows(from, route as NonNullable<typeof route>)).toBeUndefined();
    expect(reach.steps(from, bankNear(3764, 1317))).toBeUndefined();
  });
});
