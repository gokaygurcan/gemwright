import { logger } from './log';
import type { Terrain, WorkTile } from './terrain';

type Tiles = { land: number[]; statics: number[] };

// Every tile a tool works inside the cities residents are kept to, by the tiles that tool works:
// listed once at start, before anyone wakes (a whole-map scan each), and shared by every resident.
const tables = new Map<string, WorkTile[]>();
const keyOf = (tiles: Tiles) => JSON.stringify(tiles);

export function prepareAreaWork(
  terrain: Terrain,
  allowed: (p: { x: number; y: number }) => boolean,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  kinds: readonly Tiles[]
) {
  for (const tiles of kinds) {
    const started = performance.now();
    const listed: WorkTile[] = [];
    for (const tile of terrain.findTiles(tiles))
      if (
        tile.x >= bounds.minX &&
        tile.x <= bounds.maxX &&
        tile.y >= bounds.minY &&
        tile.y <= bounds.maxY &&
        allowed(tile)
      )
        listed.push(tile);
    tables.set(keyOf(tiles), listed);
    logger('mind').info(
      `[mind] work tiles in the cities: ${listed.length} in ${Math.round(performance.now() - started)} ms`
    );
  }
}

export const areaWork = (tiles: Tiles) => tables.get(keyOf(tiles));

// The best-scoring tile of each kind in a table, nearest first: a tile is not scored once the most
// it could be worth at its distance (`upper`) cannot beat the best of its kind found so far.
export function bestInArea(
  table: readonly WorkTile[],
  here: { x: number; y: number },
  score: (tile: WorkTile) => number,
  upper: (tile: WorkTile, distance: number) => number
) {
  const away = (tile: WorkTile) => Math.max(Math.abs(tile.x - here.x), Math.abs(tile.y - here.y));
  const best = new Map<string, { tile: WorkTile; value: number }>();
  for (const { tile, distance } of table
    .map((tile) => ({ tile, distance: away(tile) }))
    .sort((a, b) => a.distance - b.distance)) {
    const kind = tile.id === undefined ? `land${tile.land}` : `tile${tile.id}`;
    const found = best.get(kind);
    if (found && upper(tile, distance) <= found.value) continue;
    const value = score(tile);
    if (value > (found?.value ?? Number.NEGATIVE_INFINITY)) best.set(kind, { tile, value });
  }
  return [...best.values()].map(({ tile }) => tile);
}
