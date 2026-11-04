import { TileFlag } from '../assets/tiledata';
import { fishableWater } from './rules';

// What a land tile is, read once from the client's tiledata (its name and flags) and the ServUO
// rules (fishable water): the same answer for every resident. Map art drawn over by later
// expansions ("decimated_grass") is what it was.
export const landKinds = [
  'unknown',
  'water',
  'lava',
  'acid',
  'rock',
  'cave',
  'grass',
  'forest',
  'jungle',
  'sand',
  'snow',
  'dirt',
  'road',
  'floor',
  'field',
  'void'
] as const;
export type LandKind = (typeof landKinds)[number];

const water = new Set(fishableWater.land);
const named: [RegExp, LandKind][] = [
  [/^water/, 'water'],
  [/^lava/, 'lava'],
  [/^acid/, 'acid'],
  [/^cave/, 'cave'],
  [/^(rock|obsidian|embank|mountain)/, 'rock'],
  [/^(forest|tree|leaves)/, 'forest'],
  [/^jungle/, 'jungle'],
  [/^grass/, 'grass'],
  [/path$|^(cobble|flagstone|stone_paver|paver|pavement|road)/, 'road'],
  [/^sand/, 'sand'],
  [/^snow/, 'snow'],
  [/^dirt/, 'dirt'],
  [/^furrows/, 'field'],
  [/^(brick|wooden floor|planks|tile|marble|stone|crystal)/, 'floor'],
  [/^(void|noname|terrainfallback|nodraw|cloud)|^$/, 'void']
];

export function landKind(id: number, tile: { name: string; flags: number }): LandKind {
  if (water.has(id)) return 'water';
  const name = tile.name
    .toLowerCase()
    .replace(/^(decimated_)+/, '')
    .trim();
  const kind = named.find(([pattern]) => pattern.test(name))?.[1];
  if (kind) return kind;
  return tile.flags & TileFlag.Wet ? 'water' : 'unknown';
}
