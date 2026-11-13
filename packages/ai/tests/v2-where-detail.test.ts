import { expect, test } from 'bun:test';

import { parseRegions } from '@gemwright/common/game/regions';

import type { Spawner } from '../src/spawns';
import { Atlas, describePlace, type Place } from '../src/v2/atlas';
import { Mind } from '../src/v2/mind';
import { Roads } from '../src/v2/roads';
import { traitsOf } from '../src/v2/traits';
import type { WalkGraph } from '../src/walk-graph';

const regions = parseRegions(`<ServerRegions><Facet name="Trammel">
  <region type="TownRegion" priority="50" name="Minoc"><rect x="2400" y="400" width="300" height="300" /></region>
  <region type="DungeonRegion" priority="50" name="Shame"><rect x="5377" y="2" width="257" height="260" /></region>
  <region type="GuardedRegion" priority="50" name="Shrine of Valor"><rect x="2480" y="3920" width="20" height="20" /></region>
</Facet></ServerRegions>`);
const spawner = (x: number, y: number, kind: string): Spawner => ({
  name: kind,
  x,
  y,
  z: 0,
  map: 'Trammel',
  range: 5,
  max: 1,
  kinds: [kind],
  mx: { [kind]: 3 },
  delay: [5, 10]
});

// The land as the walk graph joins it: Minoc and its surface (node 0), Shame's first level (1) and
// second (2), each below the last by a teleporter, and a mine entered from Minoc (3); a moongate at
// Minoc.
const nodes = [
  { x: 2500, y: 500, land: 0 },
  { x: 5400, y: 100, land: 1 },
  { x: 5600, y: 100, land: 2 },
  { x: 5900, y: 300, land: 3 }
];
const graph = {
  land: Int32Array.from(nodes.map((n) => n.land)),
  data: {
    x: nodes.map((n) => n.x),
    y: nodes.map((n) => n.y),
    z: nodes.map(() => 0),
    kind: nodes.map(() => 0),
    gates: { minoc: 0 }
  },
  jumps: [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 0, to: 3 }
  ],
  landAt: (p: { x: number }) => nodes.find((n) => Math.abs(n.x - p.x) < 100)?.land,
  landNear: (p: { x: number }) => nodes.find((n) => Math.abs(n.x - p.x) < 100)?.land
} as unknown as WalkGraph;

test('a dungeon level knows what spawns on it apart from the next, and caves and gates are named', () => {
  const atlas = new Atlas(regions, [spawner(5410, 110, 'scorpion'), spawner(5610, 110, 'gazer')], [], [], graph);
  expect(atlas.offersOn(1).spawns).toEqual({ scorpion: 3 });
  expect(atlas.offersOn(2).spawns).toEqual({ gazer: 3 });
  expect(atlas.at({ x: 5600, y: 100, z: 0, map: 1 })).toMatchObject({ dungeon: 'Shame', level: 2 });
  expect(atlas.exits(0).map((e) => e.to)).toContain('Minoc mine');
  expect(atlas.near({ x: 2500, y: 500 }).map((m) => m.name)).toContain('minoc moongate');
  expect(atlas.near({ x: 2490, y: 3930 }).map((m) => m.name)).toContain('Shrine of Valor');
});

test('a spot knows which part of its region it is in and the road it stands on', () => {
  const atlas = new Atlas(regions, [], [], []);
  atlas.useRoads([
    {
      name: 'bank:Minoc-gate:minoc',
      both: true,
      points: [
        [2420, 420, 0],
        [2420, 680, 0]
      ]
    }
  ]);
  const north = atlas.at({ x: 2420, y: 430, z: 0, map: 1, direction: 4 });
  expect(north).toMatchObject({
    part: 'north-west',
    road: { from: 'Minoc', to: 'minoc moongate', toward: 'minoc moongate' }
  });
  expect(describePlace(north)).toBe(
    'north-west Minoc, on the road Minoc to minoc moongate, toward minoc moongate, guarded'
  );
  expect(atlas.at({ x: 2550, y: 550, z: 0, map: 1 }).part).toBe('centre');
});

test('a road knows the end it is faced toward and what lies along it', () => {
  const roads = new Roads(
    [
      {
        name: 'bank:Britain-bank:Yew',
        both: true,
        points: [
          [100, 100, 0],
          [148, 100, 0]
        ]
      }
    ],
    (x) => (x === 124 ? 'Shrine of Spirituality' : undefined)
  );
  expect(roads.on({ x: 120, y: 101, direction: 2 })).toEqual({
    from: 'Britain',
    to: 'Yew',
    toward: 'Yew',
    along: ['Shrine of Spirituality']
  });
  expect(roads.on({ x: 120, y: 101, direction: 6 })?.toward).toBe('Britain');
  expect(roads.on({ x: 120, y: 110 })).toBeUndefined();
});

test('where the shard and the map disagree about guards, the shard is believed and it is noted', () => {
  const written: { kind: string; data: object }[] = [];
  const mind = new Mind('r', (e) => written.push(e), traitsOf([], () => 0.5).traits);
  const place: Place = { map: 1, regions: ['Minoc'], kind: 'town', guarded: true };
  mind.observe({ resident: 'r', at: 1, kind: 'place', data: place });
  mind.observe({ resident: 'r', at: 2, kind: 'heard', data: { serial: -1, cliloc: 500113 } });
  expect(mind.guarded).toBe(false);
  expect(written.find((e) => e.kind === 'place-disagreed')?.data).toEqual({
    regions: ['Minoc'],
    map: true,
    shard: false
  });
});
