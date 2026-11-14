import { HUMAN_BODIES } from '@gemwright/common/game/bodies';
import { creatures } from '@gemwright/common/game/rules';

import type { Spawner } from '../spawns';
import type { HistoryEvent } from './history';

type Where = NonNullable<HistoryEvent['where']>;
// What it knows of one kind at one spawner: how often it came within sight, how often it saw one of
// the kind there, and when it last left seeing none.
interface Kept {
  visits: number;
  finds: number;
  found: boolean;
  left?: number;
  empty?: boolean;
}
interface Spot {
  x: number;
  y: number;
  z: number;
  range: number;
  kinds: string[];
  // Of its spawns, the share each kind is (its MX against the spawner's whole), and how many it
  // keeps at most (MaxCount).
  share: Record<string, number>;
  max: number;
  kept: Record<string, Kept>;
  // Minutes between its spawns.
  delay: [number, number];
}
// The steps of the way from one spot to another, or nothing where none joins them.
export type Steps = (from: Where, to: { x: number; y: number; z: number }) => number | undefined;
const types = new Map(creatures.map((c) => [c.type.toLowerCase(), c.type]));
// Kinds that wear a human body: seen, any of them is just a person.
const people = new Set(creatures.filter((c) => c.bodies.some((b) => HUMAN_BODIES.has(b))).map((c) => c.type));
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
// The client's view range, and the size of the squares spawners are filed under to find them near.
const sight = 18;
const square = 64;
const cell = (x: number, y: number) => `${Math.floor(x / square)},${Math.floor(y / square)}`;

// Going somewhere to do something: where it last did each attempt, and the creature spawns it knows
// in Trammel (those it has come within sight of, and those it only has the shard's word for),
// reached at the pace it has been seen to walk along the way there (walk-graph.ts): a place with no
// way to it is nowhere to go. A spawner says what may be there, not what is, and how much of it: each
// kind is that share of its spawns (ServUO XmlSpawner MX of the whole), so a full spawner holds at
// least one of a kind at the odds its share gives over its MaxCount. Each time the resident comes
// within sight of one, it is a visit for every kind, and seeing one of a kind there a find of that
// kind; the shard's word counts as two visits. A kind it last saw gone comes back over its share of
// the spawns, one each delay, counted to when it would get there.
export class Ventures {
  snapshot() {
    const { visited: _, ...state } = this;
    return state;
  }

  restore(state: ReturnType<Ventures['snapshot']>) {
    Object.assign(this, state);
  }

  private readonly done = new Map<string, Where>();
  private readonly spots = new Map<string, Spot[]>();
  private readonly byType = new Map<string, Spot[]>();
  private readonly near = new Set<Spot>();
  private walked = { tiles: 0, seconds: 0 };
  private last?: { at: number; where: Where };

  constructor(
    spawners: readonly Spawner[],
    private readonly visited: (visit: { x: number; y: number; kinds: string[]; found: string[] }) => void = () => {}
  ) {
    for (const s of spawners) {
      const kinds = s.kinds.flatMap((kind) => types.get(kind) ?? []);
      if (s.map !== 'Trammel' || !kinds.length) continue;
      // XmlSpawner makes one spawn each delay, of a kind as often as its MX is of all of them.
      const weights = s.kinds.map((kind) => [types.get(kind), s.mx[kind] ?? 1] as const);
      const total = weights.reduce((sum, [type, n]) => sum + (type ? n : 0), 0) || 1;
      const share: Record<string, number> = {};
      for (const [type, n] of weights) if (type) share[type] = (share[type] ?? 0) + n / total;
      const kept = Object.fromEntries(kinds.map((kind) => [kind, { visits: 0, finds: 0, found: false }]));
      const spot = { x: s.x, y: s.y, z: s.z, range: s.range, kinds, share, max: s.max, kept, delay: s.delay };
      this.spots.set(cell(s.x, s.y), [...(this.spots.get(cell(s.x, s.y)) ?? []), spot]);
      for (const type of kinds) this.byType.set(type, [...(this.byType.get(type) ?? []), spot]);
    }
  }

  walk(at: number, where: Where | undefined) {
    if (where && this.last && this.last.where.map === where.map && at - this.last.at < 2000) {
      this.walked.tiles += away(where, this.last.where);
      this.walked.seconds += (at - this.last.at) / 1000;
    }
    this.last = where ? { at, where } : undefined;
    if (where?.map !== 1) return this.leave(at);
    for (const spot of this.near) if (away(where, spot) > sight) this.left(spot, at);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const spot of this.spots.get(cell(where.x + dx * square, where.y + dy * square)) ?? [])
          if (away(where, spot) <= sight && !this.near.has(spot)) {
            for (const kept of Object.values(spot.kept)) kept.found = false;
            this.near.add(spot);
          }
  }

  // A creature seen: a find of its own kind for each spawner in sight whose ground it stands on (a
  // person, for a spawner's kinds of people).
  saw(name: string, x: number, y: number) {
    const kinds = name.split('/');
    const person = kinds.includes('Person');
    for (const spot of this.near) {
      if (away({ x, y }, spot) > spot.range) continue;
      for (const kind of spot.kinds)
        if (kinds.includes(kind) || (person && people.has(kind))) {
          const kept = spot.kept[kind];
          if (kept) kept.found = true;
        }
    }
  }

  // Asleep, it is no longer near anything.
  leave(at = this.last?.at ?? 0) {
    for (const spot of this.near) this.left(spot, at);
  }

  private left(spot: Spot, at: number) {
    for (const kept of Object.values(spot.kept)) {
      kept.visits++;
      if (kept.found) kept.finds++;
      kept.left = at;
      kept.empty = !kept.found;
    }
    this.visited({
      x: spot.x,
      y: spot.y,
      kinds: spot.kinds,
      found: spot.kinds.filter((kind) => spot.kept[kind]?.found)
    });
    this.near.delete(spot);
  }

  // Only what can be done there again: its own tool on the world's tiles, which stay where they are.
  // A thing it took or a creature it killed is not there to return to.
  remember(key: string, where: Where | undefined) {
    if (where && / > target (tile\d+|land\d*)$/.test(key) && key.split(' ')[1] === 'my') this.done.set(key, where);
  }

  // Each venture reachable in Trammel: what to do, where, how many seconds the walk takes, and the
  // chance of finding it there when it arrives. Without a way to measure walks, nowhere; and a place
  // outside where it may go (`allowed`) is never measured, as every measured walk is a search.
  *ahead(
    here: Where,
    available: ReadonlySet<string>,
    owns: (name: string) => boolean = () => true,
    steps?: Steps,
    allowed: (p: { x: number; y: number }) => boolean = () => true
  ) {
    // Until it has walked, a walker's pace (ServUO: a step every 0.4 seconds on foot).
    const pace = this.walked.seconds ? this.walked.tiles / this.walked.seconds : 2.5;
    if (here.map !== 1 || !steps) return;
    const now = this.last?.at ?? 0;
    // A place it worked, to work again with the same tool, if it still has one; one in sight is
    // worked from here or not at all.
    for (const [key, where] of this.done) {
      const tool = /^double-click my (.+?) > /.exec(key)?.[1];
      if (available.has(key) || where.map !== here.map || away(here, where) <= sight || (tool && !owns(tool))) continue;
      if (!allowed(where)) continue;
      const walked = steps(here, where);
      if (walked !== undefined) yield { key, where, walk: walked / pace, chance: 1 };
    }
    // A spawner in sight needs no going to: what is there it sees, and what is not it does not. One
    // it has never been within sight of is where the shard says something may be, and nothing more
    // than that: it goes on the word, at the odds of a place nothing is yet known about.
    for (const [type, spots] of this.byType)
      for (const place of spots) {
        if (away(here, place) <= sight || !allowed(place)) continue;
        const walked = steps(here, place);
        if (walked === undefined) continue;
        const walk = walked / pace;
        const share = place.share[type] ?? 0;
        const kept = place.kept[type] ?? { visits: 0, finds: 0, found: false };
        // As the shard keeps it full: at least one of its spawns of this kind; then borne out by what
        // it saw each time it passed, the shard's word counting as two passes.
        const expected = 1 - (1 - share) ** Math.max(1, place.max);
        const trusted = (kept.finds + 2 * expected) / (kept.visits + 2);
        // Seen gone, it comes back over its share of the spawns, one each delay.
        const [shortest, longest] = place.delay;
        const back = (((shortest + longest) / 2) * 60_000) / Math.max(share, Number.EPSILON);
        const filled = kept.empty && kept.left !== undefined ? Math.min(1, (now + walk * 1000 - kept.left) / back) : 1;
        yield {
          key: `attack ${type}`,
          where: { x: place.x, y: place.y, z: place.z, map: here.map },
          walk,
          chance: trusted * filled
        };
      }
  }
}
