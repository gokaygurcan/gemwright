import { fishableWater } from './rules';

// Water, for anything that has to find a shore: the tiles ServUO lets a fishing pole be cast at
// (Fishing.cs, rules.ts), land tiles of open water and the statics that stand in for it.
export const waterLandTiles: ReadonlySet<number> = new Set(fishableWater.land);
export const waterStaticGraphics: ReadonlySet<number> = new Set(fishableWater.statics);
