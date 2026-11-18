import { inRect, type Region } from '@gemwright/common/game/regions';
import { npcTypes } from '@gemwright/common/game/rules';

import { isAnkh, isForge, type Placement } from './decoration';
import type { Link } from './links';
import { type OnRoad, Roads } from './roads';
import type { Corridor } from './route-waypoints';
import type { Spawner } from './spawns';
import type { WalkGraph } from './walk-graph';

// Where a spot is, as a player who knows the map and the wiki knows it at a glance: its regions,
// innermost first; whether guards answer there; the piece of land it stands on (the mainland, an
// island, a dungeon's level) and how that is left.
export interface Place {
  map: number;
  regions: string[];
  kind: 'town' | 'dungeon' | 'guarded' | 'wild';
  guarded: boolean;
  land?: number;
  island?: string;
  dungeon?: string;
  level?: number;
  // Which part of its innermost region it is in: north, south-east, centre…
  part?: string;
  // The public road it stands on (roads.ts).
  road?: OnRoad;
  // Down to a deeper level of the dungeon it was in, or up to a shallower one (perceive.ts).
  came?: 'up' | 'down';
}

export interface Exit {
  by: 'teleporter' | 'moongate';
  x: number;
  y: number;
  // Where it puts one, as a place.
  to: string;
}

export interface Landmark {
  kind: 'ankh' | 'healer' | 'banker' | 'vendor' | 'moongate' | 'teleporter' | 'forge' | 'entrance' | 'shrine';
  name: string;
  x: number;
  y: number;
}

// What a region holds: its vendors by kind, bankers, healers and ankhs, and what spawns there.
export interface Offers {
  vendors: Record<string, number>;
  bankers: number;
  healers: number;
  ankhs: number;
  spawns: Record<string, number>;
}

interface Land {
  nodes: number;
  surface: boolean;
  name: string;
  dungeon?: string;
  level?: number;
  exits: Exit[];
}

const SURFACE = 5120;
const GRID = 16;
const SIGHT = 18;
const guardedTypes = new Set(['TownRegion', 'GuardedRegion', 'NewMaginciaRegion']);
const npcByName = new Map(npcTypes.map((type) => [type.toLowerCase(), type]));
const key = (x: number, y: number) => Math.floor(x / GRID) * 1024 + Math.floor(y / GRID);
// The grid cells a rectangle (corners inclusive) touches.
const cells = (left: number, top: number, right: number, bottom: number) => {
  const found: number[] = [];
  for (let cx = Math.floor(left / GRID); cx <= Math.floor(right / GRID); cx++)
    for (let cy = Math.floor(top / GRID); cy <= Math.floor(bottom / GRID); cy++) found.push(cx * 1024 + cy);
  return found;
};
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// The shard's Trammel as a map: built once at start from its world files and the walk graph, so
// that every step is a lookup.
export class Atlas {
  private readonly regions = new Map<number, Region[]>();
  private readonly byName = new Map<string, Region>();
  private readonly lands = new Map<number, Land>();
  private readonly marks = new Map<number, Landmark[]>();
  private readonly spawners: Spawner[];
  private readonly offered = new Map<string, Offers>();
  private readonly onLand = new Map<number, Offers>();
  private roads?: Roads;

  constructor(
    regions: readonly Region[],
    spawners: readonly Spawner[],
    decoration: readonly Placement[],
    teleporters: readonly Link[],
    private readonly graph?: WalkGraph
  ) {
    for (const region of regions) {
      if (region.facet !== 'Trammel') continue;
      this.byName.set(region.name, region);
      for (const rect of region.rects)
        for (const at of cells(rect.x, rect.y, rect.x + rect.width - 1, rect.y + rect.height - 1))
          this.index(this.regions, at, region);
    }
    this.spawners = spawners.filter((s) => s.map === 'Trammel');
    const mark = (landmark: Landmark) => this.index(this.marks, key(landmark.x, landmark.y), landmark);
    for (const p of decoration) {
      if (isAnkh(p.type)) mark({ kind: 'ankh', name: 'ankh', x: p.x, y: p.y });
      else if (isForge(p.graphic)) mark({ kind: 'forge', name: 'forge', x: p.x, y: p.y });
    }
    for (const s of this.spawners)
      for (const kind of s.kinds) {
        const type = npcByName.get(kind);
        if (!type) continue;
        const what = type.endsWith('Healer') ? 'healer' : type.endsWith('Banker') ? 'banker' : 'vendor';
        mark({ kind: what, name: type, x: s.x, y: s.y });
      }
    for (const link of teleporters) mark({ kind: 'teleporter', name: 'teleporter', ...link.from });
    for (const region of this.byName.values()) {
      if (region.entrance) mark({ kind: 'entrance', name: `${region.name} entrance`, ...region.entrance });
      const rect = region.rects[0];
      if (region.name.startsWith('Shrine of ') && rect)
        mark({ kind: 'shrine', name: region.name, x: rect.x + (rect.width >> 1), y: rect.y + (rect.height >> 1) });
    }
    if (graph) {
      for (const [name, id] of Object.entries(graph.data.gates))
        mark({ kind: 'moongate', name: `${name} moongate`, x: graph.data.x[id] ?? 0, y: graph.data.y[id] ?? 0 });
      this.learnLands(graph);
    }
  }

  private index<T>(map: Map<number, T[]>, at: number, value: T) {
    const list = map.get(at) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(at, list);
  }

  // The named regions a spot lies in, innermost first.
  regionsAt(x: number, y: number) {
    const here = (this.regions.get(key(x, y)) ?? []).filter((r) => r.rects.some((rect) => inRect(rect, { x, y })));
    const depth = (r: Region): number => {
      const parent = r.parent ? this.byName.get(r.parent) : undefined;
      return parent ? 1 + depth(parent) : 0;
    };
    return here.sort((a, b) => depth(b) - depth(a));
  }

  // Whether guards answer at a spot: the innermost region that says so, its own or its parent's.
  private guarded(chain: readonly Region[]) {
    for (
      let region: Region | undefined = chain[0];
      region;
      region = region.parent ? this.byName.get(region.parent) : undefined
    ) {
      if (region.unguarded) return false;
      if (region.type === 'DungeonRegion') return false;
      if (guardedTypes.has(region.type)) return true;
    }
    return false;
  }

  // The public roads (routes.ts corridors), each with the towns and entrances along it.
  useRoads(corridors: readonly Corridor[]) {
    this.roads = new Roads(corridors, (x, y) => {
      const near = this.near({ x, y }, 8).find((m) => m.kind === 'entrance' || m.kind === 'shrine');
      return near?.name ?? this.regionsAt(x, y).find((r) => r.type === 'TownRegion')?.name;
    });
  }

  at(p: { x: number; y: number; z: number; map: number | null; direction?: number }): Place {
    const chain = this.regionsAt(p.x, p.y);
    const lineage: Region[] = [];
    for (
      let region: Region | undefined = chain[0];
      region;
      region = region.parent ? this.byName.get(region.parent) : undefined
    )
      lineage.push(region);
    const types = new Set(lineage.map((r) => r.type));
    const guarded = this.guarded(chain);
    const land = this.graph?.landAt(p);
    const piece = land === undefined ? undefined : this.lands.get(land);
    // A dungeon's level is underground even where no region rectangle reaches.
    const kind =
      types.has('DungeonRegion') || piece?.dungeon
        ? 'dungeon'
        : types.has('TownRegion')
          ? 'town'
          : guarded
            ? 'guarded'
            : 'wild';
    const road = this.roads?.on(p);
    const part = chain[0] && partOf(chain[0], p);
    return {
      map: p.map ?? 1,
      regions: lineage.map((r) => r.name),
      kind,
      guarded,
      ...(land === undefined ? {} : { land }),
      ...(piece?.surface ? { island: piece.name } : {}),
      ...(piece?.dungeon ? { dungeon: piece.dungeon } : {}),
      ...(piece?.level ? { level: piece.level } : {}),
      ...(part ? { part } : {}),
      ...(road ? { road } : {})
    };
  }

  // What spawns on a piece of land, a dungeon's level apart from the next: the spawners standing on it.
  offersOn(land: number | undefined): Offers {
    const empty: Offers = { vendors: {}, bankers: 0, healers: 0, ankhs: 0, spawns: {} };
    if (land === undefined || !this.graph) return empty;
    if (!this.onLand.size)
      for (const s of this.spawners) {
        const on = this.graph.landNear(s);
        if (on === undefined) continue;
        const offers = this.onLand.get(on) ?? { vendors: {}, bankers: 0, healers: 0, ankhs: 0, spawns: {} };
        tally(offers, s);
        this.onLand.set(on, offers);
      }
    return this.onLand.get(land) ?? empty;
  }

  // Whether a spot lies within the cities residents are kept to (gemwright.json ai.cities): in the
  // outermost region that holds each city, its town and the grounds about it (New Haven: Haven
  // Island). Every spot, when none are named.
  within(cities: readonly string[] | undefined) {
    if (!cities?.length) return () => true;
    const outer = cities.flatMap((city) => {
      let region = this.byName.get(city);
      while (region?.parent && this.byName.get(region.parent)) region = this.byName.get(region.parent);
      return region ? [region.name] : [];
    });
    if (outer.length !== cities.length)
      throw new Error(
        `gemwright.json ai.cities names a city the shard's Regions.xml does not have: ${cities.join(', ')}`
      );
    return (p: { x: number; y: number }) => this.regionsAt(p.x, p.y).some((r) => outer.includes(r.name));
  }

  // The box around the cities a resident is kept to (their outermost regions), or nothing when it may
  // go anywhere: no place it may go lies outside it.
  bounds(cities: readonly string[] | undefined) {
    if (!cities?.length) return undefined;
    const rects = cities.flatMap((city) => {
      let region = this.byName.get(city);
      while (region?.parent && this.byName.get(region.parent)) region = this.byName.get(region.parent);
      return region?.rects ?? [];
    });
    if (!rects.length) return undefined;
    return {
      minX: Math.min(...rects.map((r) => r.x)),
      minY: Math.min(...rects.map((r) => r.y)),
      maxX: Math.max(...rects.map((r) => r.x + r.width - 1)),
      maxY: Math.max(...rects.map((r) => r.y + r.height - 1))
    };
  }

  // How a piece of land is left: its teleporters and moongates, and where each puts one, nearest first.
  exits(land: number | undefined, from?: { x: number; y: number }) {
    const exits = land === undefined ? [] : (this.lands.get(land)?.exits ?? []);
    return from ? [...exits].sort((a, b) => away(a, from) - away(b, from)) : exits;
  }

  // What lies within sight of a spot, nearest first.
  near(p: { x: number; y: number }, range = SIGHT) {
    const found: Landmark[] = [];
    for (const at of cells(p.x - range, p.y - range, p.x + range, p.y + range))
      for (const mark of this.marks.get(at) ?? []) if (away(mark, p) <= range) found.push(mark);
    return found.sort((a, b) => away(a, p) - away(b, p));
  }

  // What a region (and every region within it) holds.
  offers(name: string): Offers {
    const known = this.offered.get(name);
    if (known) return known;
    const region = this.byName.get(name);
    const offers: Offers = { vendors: {}, bankers: 0, healers: 0, ankhs: 0, spawns: {} };
    if (region) for (const s of this.spawners) if (region.rects.some((rect) => inRect(rect, s))) tally(offers, s);
    if (region)
      for (const marks of this.marks.values())
        for (const m of marks) if (m.kind === 'ankh' && region.rects.some((rect) => inRect(rect, m))) offers.ankhs++;
    this.offered.set(name, offers);
    return offers;
  }

  // Each piece of land: named by the region most of it lies in; the largest on the surface is the
  // mainland, the rest islands; below, a dungeon's pieces are its levels, counted in teleporter
  // jumps from the surface.
  private learnLands(graph: WalkGraph) {
    const { x, y } = graph.data;
    const names = new Map<number, Map<string, number>>();
    for (let i = 0; i < graph.land.length; i++) {
      const land = graph.land[i] ?? i;
      const nx = x[i] ?? 0;
      const ny = y[i] ?? 0;
      const piece = this.lands.get(land) ?? { nodes: 0, surface: nx < SURFACE, name: '', exits: [] };
      piece.nodes++;
      this.lands.set(land, piece);
      const chain = this.regionsAt(nx, ny);
      const named = piece.surface
        ? (chain.find((r) => r.type === 'TownRegion') ?? chain.at(-1))?.name
        : chain.find((r) => r.type === 'DungeonRegion')?.name;
      if (!named) continue;
      const tally = names.get(land) ?? new Map<string, number>();
      tally.set(named, (tally.get(named) ?? 0) + 1);
      names.set(land, tally);
    }
    let mainland: number | undefined;
    for (const [land, piece] of this.lands) {
      const best = [...(names.get(land) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (piece.surface) {
        piece.name = best ?? 'an island';
        if (mainland === undefined || piece.nodes > (this.lands.get(mainland)?.nodes ?? 0)) mainland = land;
      } else {
        piece.dungeon = best;
        piece.name = best ?? 'underground';
      }
    }
    if (mainland !== undefined) (this.lands.get(mainland) as Land).name = 'the mainland';
    // A cave or mine no dungeon region names: after the town it is entered from (Minoc mine), else
    // the region or land of its entrance.
    for (const { from, to } of graph.jumps) {
      const below = this.lands.get(graph.land[to] ?? to);
      const above = this.lands.get(graph.land[from] ?? from);
      if (!below || below.surface || below.dungeon || !above?.surface || below.name !== 'underground') continue;
      const chain = this.regionsAt(x[from] ?? 0, y[from] ?? 0);
      const town = chain.find((r) => r.type === 'TownRegion')?.name;
      below.name = town ? `${town} mine` : `cave by ${chain[0]?.name ?? above.name}`;
    }
    // Levels: breadth-first over teleporter jumps from the surface.
    const next = new Map<number, number[]>();
    let frontier: number[] = [];
    for (const { from, to } of graph.jumps) {
      const a = graph.land[from] ?? from;
      const b = graph.land[to] ?? to;
      if (a === b) continue;
      next.set(a, [...(next.get(a) ?? []), b]);
      const below = this.lands.get(b);
      if (this.lands.get(a)?.surface && below && !below.surface && below.dungeon && !below.level) {
        below.level = 1;
        frontier.push(b);
      }
    }
    for (let level = 2; frontier.length; level++) {
      const found: number[] = [];
      for (const land of frontier)
        for (const b of next.get(land) ?? []) {
          const piece = this.lands.get(b);
          if (piece && !piece.surface && piece.dungeon && !piece.level) {
            piece.level = level;
            found.push(b);
          }
        }
      frontier = found;
    }
    const gates = new Map(Object.entries(graph.data.gates).map(([name, id]) => [id, name]));
    for (const { from, to } of graph.jumps) {
      const a = graph.land[from] ?? from;
      const b = graph.land[to] ?? to;
      const piece = this.lands.get(a);
      const there = this.lands.get(b);
      if (!piece || !there || a === b) continue;
      const gate = gates.get(from);
      if (gate !== undefined) {
        const name = gates.get(to);
        if (!piece.exits.some((e) => e.by === 'moongate' && e.to === name))
          piece.exits.push({ by: 'moongate', x: x[from] ?? 0, y: y[from] ?? 0, to: name ?? there.name });
        continue;
      }
      const exit = {
        by: 'teleporter' as const,
        x: x[from] ?? 0,
        y: y[from] ?? 0,
        to: there.level ? `${there.name} level ${there.level}` : there.name
      };
      if (!piece.exits.some((e) => e.x === exit.x && e.y === exit.y)) piece.exits.push(exit);
    }
  }
}

// A place in a few words: "north Britain, guarded", "Shame level 2, down", "on the road Britain to
// Yew, toward Yew".
export function describePlace(place: Place) {
  const region =
    place.regions[0] &&
    (place.part && place.part !== 'centre' ? `${place.part} ${place.regions[0]}` : place.regions[0]);
  const where = place.dungeon
    ? `${place.dungeon}${place.level ? ` level ${place.level}` : ''}${place.came ? `, ${place.came}` : ''}`
    : [region, place.island && place.island !== place.regions.at(-1) ? place.island : undefined]
        .filter(Boolean)
        .join(', ') ||
      place.island ||
      'the wilds';
  const road = place.road
    ? `, on the road ${place.road.from} to ${place.road.to}${place.road.toward ? `, toward ${place.road.toward}` : ''}`
    : '';
  return `${where}${road}${place.dungeon ? '' : `, ${place.guarded ? 'guarded' : 'unguarded'}`}`;
}

// A spawner's kinds counted into what a place offers.
function tally(offers: Offers, s: Spawner) {
  for (const kind of s.kinds) {
    const type = npcByName.get(kind);
    const count = s.mx[kind] ?? 1;
    if (!type) offers.spawns[kind] = (offers.spawns[kind] ?? 0) + count;
    else if (type.endsWith('Banker')) offers.bankers++;
    else if (type.endsWith('Healer')) offers.healers++;
    else offers.vendors[type] = (offers.vendors[type] ?? 0) + 1;
  }
}

// Which part of a region a spot is in, by thirds of the box its rectangles span.
function partOf(region: Region, p: { x: number; y: number }) {
  const left = Math.min(...region.rects.map((r) => r.x));
  const top = Math.min(...region.rects.map((r) => r.y));
  const right = Math.max(...region.rects.map((r) => r.x + r.width));
  const bottom = Math.max(...region.rects.map((r) => r.y + r.height));
  const third = (at: number, low: number, high: number) =>
    at < low + (high - low) / 3 ? 0 : at < low + ((high - low) * 2) / 3 ? 1 : 2;
  const ns = ['north', '', 'south'][third(p.y, top, bottom)] ?? '';
  const ew = ['west', '', 'east'][third(p.x, left, right)] ?? '';
  return ns && ew ? `${ns}-${ew}` : ns || ew || 'centre';
}

// Where a plan leads when that is another piece of land than here (an island, a dungeon's level),
// and the teleporters and moongates on the way, each with where it puts it. Nothing when the plan
// stays on the land it stands on.
export function journey(
  steps: readonly { verb: string; x?: number; y?: number }[],
  from: { x: number; y: number; z: number; map: number | null },
  here: Place | undefined,
  at: (p: { x: number; y: number; z: number; map: number | null }) => Place,
  way: {
    stand: (p: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | undefined;
    route: (
      from: { x: number; y: number; z: number },
      to: { x: number; y: number; z: number },
      seed: number
    ) => { legs: readonly ({ kind: string; x: number; y: number; z: number } & { to?: string })[] } | undefined;
  }
) {
  const last = steps.findLast(
    (step) => (step.verb === 'walk' || step.verb === 'seek' || step.verb === 'sell-to') && step.x !== undefined
  );
  if (!last || last.x === undefined || last.y === undefined) return undefined;
  const end = way.stand({ x: last.x, y: last.y, z: from.z });
  if (!end) return undefined;
  const there = at({ ...end, map: from.map });
  if (there.land === here?.land) return undefined;
  const legs = way.route(from, end, 0)?.legs ?? [];
  const via = legs.flatMap((leg, i) => {
    if (leg.kind === 'walk') return [];
    const next = legs[i + 1];
    const to =
      leg.kind === 'gate' ? `moongate to ${leg.to}` : next ? describePlace(at({ ...next, map: from.map })) : '';
    return [{ by: leg.kind, x: leg.x, y: leg.y, to }];
  });
  return { to: describePlace(there), place: there, via };
}
