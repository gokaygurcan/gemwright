import { readdirSync, readFileSync } from 'node:fs';

import type { Gate } from './moongate';
import { distance } from './navigation';
import { crowdFactor, pickWeighted, residentsWhere } from './spread';

// Trammel dungeons from catalogs/dungeons (built by build-dungeons.ts) and the creatures their
// rooms spawn from catalogs/monsters.json (build-monsters.ts).
interface Point {
  x: number;
  y: number;
  z: number;
}
export interface Room {
  name: string;
  at: Point;
  range: number;
  monsters: { type: string; max: number }[];
}
export interface Stair {
  at: Point;
  to: Point;
  toFloor: number | null;
  width: number;
}
export interface Floor {
  id: number;
  depth: number;
  stairs: Stair[];
  rooms: Room[];
}
export interface Dungeon {
  name: string;
  entrance: Point;
  // `gate` is the public moongate an entrance can be walked to from (build-dungeons.ts).
  entries: { from: Point; to: Point; floor: number; gate: Gate }[];
  floors: Floor[];
}
export interface Monster {
  type: string;
  name: string | null;
  bodies: number[];
  hits: number[] | null;
  damage: number[] | null;
  magery: number;
  resist: number;
  fame: number;
  // Attacks on sight (its ServUO FightMode); combat skills, armor and the gold its loot packs carry.
  aggressive?: boolean;
  tactics?: number;
  wrestling?: number;
  armor?: number;
  gold?: number;
}

const directory = new URL('../catalogs/dungeons/', import.meta.url);
// Khaldun is entered through a quest; nothing an ordinary visitor can do opens it.
export const dungeons: Dungeon[] = readdirSync(directory)
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as Dungeon)
  .filter((dungeon) => dungeon.name !== 'Khaldun' && dungeon.entries.length);
export const monsters: Monster[] = (
  JSON.parse(readFileSync(new URL('../catalogs/monsters.json', import.meta.url), 'utf8')) as { monsters: Monster[] }
).monsters;

export const dungeonNamed = (name: string | undefined) => dungeons.find((dungeon) => dungeon.name === name);

// The surface entrance closest to a point; dungeons have several.
export const nearestEntry = (dungeon: Dungeon, from: { x: number; y: number }) =>
  [...dungeon.entries].sort((a, b) => distance(from, a.from) - distance(from, b.from))[0];

// A town's own dungeons are its two nearest by entrance; a fifth of runs go to any other.
export const AWAY_CHANCE = 0.2;
export function chooseDungeon(home: { x: number; y: number }, random = Math.random): Dungeon {
  const byDistance = [...dungeons].sort(
    (a, b) =>
      distance(home, nearestEntry(a, home)?.from ?? a.entrance) -
      distance(home, nearestEntry(b, home)?.from ?? b.entrance)
  );
  const pool = random() < AWAY_CHANCE ? byDistance.slice(2) : byDistance.slice(0, 2);
  // Within the pool, dungeons already full of residents are less likely (spread.ts).
  return (
    pickWeighted(
      pool,
      (d) =>
        crowdFactor(
          residentsWhere((at) => inBounds(d, at)),
          3,
          12
        ),
      random
    ) ?? (byDistance[0] as Dungeon)
  );
}

// The rectangle around a dungeon's rooms and stairways.
const bounds = new Map<Dungeon, { x0: number; y0: number; x1: number; y1: number }>();
for (const dungeon of dungeons) {
  const points = dungeon.floors.flatMap((f) => [...f.rooms.map((r) => r.at), ...f.stairs.map((s) => s.at)]);
  bounds.set(dungeon, {
    x0: Math.min(...points.map((p) => p.x)) - 20,
    y0: Math.min(...points.map((p) => p.y)) - 20,
    x1: Math.max(...points.map((p) => p.x)) + 20,
    y1: Math.max(...points.map((p) => p.y)) + 20
  });
}
const inBounds = (dungeon: Dungeon, at: { x: number; y: number }) => {
  const b = bounds.get(dungeon);
  return !!b && at.x >= b.x0 && at.x <= b.x1 && at.y >= b.y0 && at.y <= b.y1;
};

// The floor whose rooms or stairs are nearest at a similar height; floors overlap in x and y.
export function floorAt(dungeon: Dungeon, at: Point): Floor | undefined {
  let best: { floor: Floor; score: number } | undefined;
  for (const floor of dungeon.floors)
    for (const point of [...floor.rooms.map((r) => r.at), ...floor.stairs.map((s) => s.at)]) {
      const score = distance(at, point) + Math.max(0, Math.abs(at.z - point.z) - 10) * 4;
      if (!best || score < best.score) best = { floor, score };
    }
  return best && best.score < 80 ? best.floor : undefined;
}

export const inside = (dungeon: Dungeon, at: Point) => floorAt(dungeon, at) !== undefined;

// Descending stairs lead to a deeper floor; the way out is the stair to the shallowest floor, or
// to the surface from the top floor.
export const deeperStairs = (dungeon: Dungeon, floor: Floor) =>
  floor.stairs.filter((stair) => {
    const target = dungeon.floors.find((f) => f.id === stair.toFloor);
    return target !== undefined && target.depth > floor.depth;
  });
export function exitStair(dungeon: Dungeon, floor: Floor, from: { x: number; y: number }): Stair | undefined {
  const up = floor.stairs.filter((stair) => {
    if (stair.toFloor === null) return true;
    const target = dungeon.floors.find((f) => f.id === stair.toFloor);
    return target !== undefined && target.depth < floor.depth;
  });
  return up.sort((a, b) => distance(from, a.at) - distance(from, b.at))[0];
}

// Rolls the crawler's next goal on its floor, after UO Offline: every unvisited room weighs 1,
// visited ones 0.15, and each stairway down weighs from 0.5 at the weakest qualifying skill (80.0)
// to 2.0 at 100.0, so depth thins out the way it does on a real shard. `descend` scales that
// weight down for a short-handed party.
export function rollGoal(
  dungeon: Dungeon,
  floor: Floor,
  options: { skill: number; visited: ReadonlySet<string>; avoided: ReadonlySet<string>; descend?: number },
  random = Math.random
): { kind: 'room'; room: Room } | { kind: 'descend'; stair: Stair } | undefined {
  const descendWeight = (0.5 + (Math.min(100, Math.max(80, options.skill)) - 80) * 0.075) * (options.descend ?? 1);
  const choices: { weight: number; goal: { kind: 'room'; room: Room } | { kind: 'descend'; stair: Stair } }[] = [
    ...floor.rooms
      .filter((room) => !options.avoided.has(room.name))
      .map((room) => ({
        weight: options.visited.has(room.name) ? 0.15 : 1,
        goal: { kind: 'room' as const, room }
      })),
    ...deeperStairs(dungeon, floor).map((stair) => ({
      weight: descendWeight,
      goal: { kind: 'descend' as const, stair }
    }))
  ];
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  let roll = random() * total;
  for (const choice of choices) {
    roll -= choice.weight;
    if (roll <= 0) return choice.goal;
  }
  return choices.at(-1)?.goal;
}

// Stairways from one floor to another, fewest first (breadth-first over the stairway graph).
export function stairRoute(dungeon: Dungeon, from: number, to: number): Stair[] | undefined {
  const via = new Map<number, Stair[]>([[from, []]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as number;
    const path = via.get(id) ?? [];
    if (id === to) return path;
    for (const stair of dungeon.floors.find((floor) => floor.id === id)?.stairs ?? []) {
      if (stair.toFloor === null || via.has(stair.toFloor)) continue;
      via.set(stair.toFloor, [...path, stair]);
      queue.push(stair.toFloor);
    }
  }
  return undefined;
}
