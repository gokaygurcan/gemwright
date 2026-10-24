// Whether a 7x7 classic house fits on a spot, by ServUO's placement rules (HousePlacement.Check)
// read against the map files alone: the house's walls rest flat on passable, non-road land
// (Map.GetAverageZ equal to the house's z), nothing impassable or solid stands inside it, and the
// ring of tiles around its walls is passable and not road. Items, mobiles and other houses are
// only known to the server, so a lot can still be refused live (house-lots.ts `refuseLot`).
export interface MapCells {
  cell(x: number, y: number): { land: { id: number; z: number }; statics: { id: number; z: number }[] };
  tile(id: number, item?: boolean): { flags: number; height: number };
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BACKGROUND = 0x1;
const IMPASSABLE = 0x40;
const SURFACE = 0x200;
const BRIDGE = 0x400;
// HousePlacement.m_RoadIDs: roads, sand stones and furrows, as inclusive ranges.
const ROADS = [
  [0x71, 0x78],
  [0xe8, 0xeb],
  [0x7ae, 0x7b1],
  [0x3ff4, 0x3ff4],
  [0x3ff8, 0x3ffb],
  [0x442, 0x479],
  [0x501, 0x510],
  [0x9, 0x15],
  [0x150, 0x15c]
] as const;
const road = (id: number) => ROADS.some(([low, high]) => id >= low && id <= high);

// Map.GetAverageZ: the lower diagonal's floored mean.
export function averageZ(map: MapCells, x: number, y: number): number {
  const top = map.cell(x, y).land.z;
  const left = map.cell(x, y + 1).land.z;
  const right = map.cell(x + 1, y).land.z;
  const bottom = map.cell(x + 1, y + 1).land.z;
  const floor = (a: number, b: number) => Math.floor((a + b) / 2);
  return Math.abs(top - bottom) > Math.abs(left - right) ? floor(left, right) : floor(top, bottom);
}

const height = (map: MapCells, id: number) => {
  const tile = map.tile(id, true);
  return tile.flags & BRIDGE ? tile.height / 2 : tile.height;
};
const inside = (rects: readonly Rect[], x: number, y: number) =>
  rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

// The house centre's z when it fits at (x, y), else undefined. `excluded` holds the server's
// no-housing regions (towns, dungeons; Data/Regions.xml).
export function houseFits(map: MapCells, x: number, y: number, excluded: readonly Rect[] = []): number | undefined {
  const z = averageZ(map, x, y);
  // The 7x7 body and the three front steps (SmallOldHouse.AreaArray).
  const body: [number, number][] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) body.push([dx, dy]);
  for (let dx = -1; dx <= 1; dx++) body.push([dx, 4]);
  for (const [dx, dy] of body) {
    const tx = x + dx;
    const ty = y + dy;
    if (inside(excluded, tx, ty)) return undefined;
    const { land, statics } = map.cell(tx, ty);
    if (road(land.id)) return undefined;
    const wall = dy !== 4 && (Math.abs(dx) === 3 || Math.abs(dy) === 3);
    const average = averageZ(map, tx, ty);
    // Walls need flat passable land at the house's z; the floor and steps only need no land above it.
    if (wall && (average !== z || map.tile(land.id).flags & IMPASSABLE)) return undefined;
    if (!wall && average > z) return undefined;
    for (const item of statics) {
      const flags = map.tile(item.id, true).flags;
      const solid = flags & IMPASSABLE || (flags & SURFACE && !(flags & BACKGROUND));
      if (solid && item.z + height(map, item.id) > z && item.z < z + 30) return undefined;
    }
  }
  // The ring around the walls: passable, not road, nothing solid above the house's floor.
  for (let dx = -4; dx <= 4; dx++)
    for (let dy = -4; dy <= 4; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 4) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (inside(excluded, tx, ty)) return undefined;
      const { land, statics } = map.cell(tx, ty);
      if (road(land.id) || map.tile(land.id).flags & IMPASSABLE) return undefined;
      for (const item of statics) {
        const flags = map.tile(item.id, true).flags;
        if (flags & IMPASSABLE || (flags & SURFACE && !(flags & BACKGROUND) && item.z + height(map, item.id) > z + 2))
          return undefined;
      }
    }
  return z;
}

// Lot centres on the 9x13 grid inside a district, each with the room its house and yard need.
export function lotGrid(district: Rect, pitch = { x: 9, y: 13 }) {
  const centres: { i: number; j: number; x: number; y: number }[] = [];
  for (let j = 0; 4 + j * pitch.y + 5 < district.height; j++)
    for (let i = 0; 4 + i * pitch.x + 4 < district.width; i++)
      centres.push({ i, j, x: district.x + 4 + i * pitch.x, y: district.y + 4 + j * pitch.y });
  return centres;
}
