import type { Point, Terrain } from './terrain';

export interface GeometryTile extends Point {
  id: number;
}
export interface GeometrySnapshot {
  revision: string;
  tiles: GeometryTile[];
  houses?: { serial: number; minX: number; maxX: number; minY: number; maxY: number; unknown: boolean }[];
}

// The base terrain and its shared buffers remain immutable; each view owns its overlay.
export function geometryView(base: Terrain, snapshot: GeometrySnapshot): Terrain {
  const cells = new Map<number, GeometryTile[]>();
  for (const tile of snapshot.tiles) {
    const key = tile.x * 4096 + tile.y;
    const cell = cells.get(key) ?? [];
    cell.push(tile);
    cells.set(key, cell);
  }
  const view = Object.create(base) as Terrain;
  Object.defineProperty(view, 'geometry', { value: snapshot });
  view.cell = (x, y) => {
    const cell = base.cell(x, y),
      extra = cells.get(x * 4096 + y);
    return extra ? { land: cell.land, statics: [...cell.statics, ...extra] } : cell;
  };
  view.sharedBuffers = () => base.sharedBuffers();
  return view;
}

export function houseBarriers(
  snapshot: GeometrySnapshot | undefined,
  from: Point,
  goal: { x: number; y: number }
): Set<string> {
  const blocked = new Set<string>();
  for (const house of snapshot?.houses ?? []) {
    const contains = (p: { x: number; y: number }) =>
      p.x >= house.minX && p.x <= house.maxX && p.y >= house.minY && p.y <= house.maxY;
    if (house.maxX - house.minX > 512 || house.maxY - house.minY > 512)
      throw new Error('Observed structure bounds exceed supported size');
    if (contains(from) || (!house.unknown && contains(goal))) continue;
    for (let x = house.minX; x <= house.maxX; x++)
      for (let y = house.minY; y <= house.maxY; y++) blocked.add(`${x},${y}`);
  }
  return blocked;
}
