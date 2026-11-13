import { expect, test } from 'bun:test';

import { parseRegions } from '@gemwright/common/game/regions';

import { Atlas, describePlace } from '../src/v2/atlas';
import { Mind } from '../src/v2/mind';
import { traitsOf } from '../src/v2/traits';

const regions = parseRegions(`<ServerRegions><Facet name="Trammel">
  <region type="NoHousingRegion" priority="50" name="Haven Island">
    <rect x="3314" y="2345" width="500" height="750" />
    <region type="TownRegion" priority="50" name="New Haven">
      <rect x="3420" y="2500" width="160" height="140" />
    </region>
  </region>
  <region type="TownRegion" priority="50" name="Britain">
    <rect x="1000" y="1000" width="200" height="200" />
    <region name="Britain Graveyard"><rect x="1100" y="1100" width="20" height="20" /><guards disabled="true" /></region>
  </region>
  <region type="DungeonRegion" priority="50" name="Shame">
    <rect x="5377" y="2" width="257" height="260" />
    <entrance x="512" y="1559" />
  </region>
</Facet></ServerRegions>`);

test('a spot is known by its regions, guards and dungeon at once', () => {
  const atlas = new Atlas(regions, [], [], []);
  const town = atlas.at({ x: 1050, y: 1050, z: 0, map: 1 });
  expect(town).toMatchObject({ regions: ['Britain'], kind: 'town', guarded: true });
  expect(atlas.at({ x: 1105, y: 1105, z: 0, map: 1 })).toMatchObject({
    regions: ['Britain Graveyard', 'Britain'],
    guarded: false
  });
  expect(atlas.at({ x: 5400, y: 100, z: 0, map: 1 })).toMatchObject({ kind: 'dungeon', guarded: false });
  expect(atlas.at({ x: 600, y: 600, z: 0, map: 1 })).toMatchObject({ regions: [], kind: 'wild' });
  expect(atlas.near({ x: 515, y: 1560 }).map((m) => m.name)).toEqual(['Shame entrance']);
  expect(describePlace(town)).toBe('north-west Britain, guarded');
});

test('the mind knows where it is from each place event', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const place = new Atlas(regions, [], [], []).at({ x: 1105, y: 1105, z: 0, map: 1 });
  mind.observe({ resident: 'r', at: 1, kind: 'place', data: place });
  expect(mind.here).toEqual(place);
  expect(mind.guarded).toBe(false);
});

test('kept to New Haven, a resident may be anywhere on its island and nowhere else', () => {
  const allowed = new Atlas(regions, [], [], []).within(['New Haven']);
  expect(allowed({ x: 3500, y: 2560 })).toBe(true);
  expect(allowed({ x: 3350, y: 2900 })).toBe(true);
  expect(allowed({ x: 1050, y: 1050 })).toBe(false);
  expect(new Atlas(regions, [], [], []).within(undefined)({ x: 1050, y: 1050 })).toBe(true);
});
