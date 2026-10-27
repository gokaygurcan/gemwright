import { existsSync, readFileSync } from 'node:fs';

import { lasting } from './lasting';
import type { Terrain } from './terrain';

// Where a resident can actually walk (the life-goal plan, ROADMAP.md step 3). locations/areas.json
// (build-areas.ts) puts every known place in an area: places a walk joins, or a teleporter. A place
// is within reach when it is in the resident's own area, or when both areas have a public moongate
// (the gates join them). Where the resident stands is found by walking to the nearest known
// places, kept by 16-tile cell for two hours. Unknown means no filtering: nothing is ruled out on
// a guess.
interface Areas {
  areas: { id: number; gates: string[] }[];
  points: { x: number; y: number; kind: string; area: number }[];
}
const file = new URL('../locations/areas.json', import.meta.url);
const data: Areas = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { areas: [], points: [] };
const byPoint = new Map(data.points.map((p) => [`${p.x},${p.y}`, p.area]));
const gated = new Set(data.areas.filter((a) => a.gates.length).map((a) => a.id));
const cells = lasting('area-of');
const cellKey = (p: { x: number; y: number }) => `${p.x >> 4},${p.y >> 4}`;

// The area of a catalogued place, if it is one.
export const areaOfPlace = (p: { x: number; y: number }) => byPoint.get(`${p.x},${p.y}`);

// The area the resident stands in, as last found for this spot (sync; see locate). Kept across
// restarts in one number: the expiry in seconds, then the area (+2, so a pocket's -1 fits).
export function areaHere(p: { x: number; y: number }): number | undefined {
  const value = cells.get(cellKey(p));
  if (value === undefined || Math.floor(value / 10_000) * 1000 < Date.now()) return undefined;
  return (value % 10_000) - 2;
}

// True when `place` can be reached from where the resident stands: same area, or both gated.
// Where it stands may be unknown; a place out of every gated area is still ruled out.
export function withinReach(from: { x: number; y: number }, place: { x: number; y: number }) {
  const here = areaHere(from);
  const there = areaOfPlace(place);
  if (there === undefined || here === there) return true;
  // An area with no moongate is reached only from inside it (a sea serpent spawn out at sea).
  if (!gated.has(there)) return false;
  return here === undefined || gated.has(here);
}

// True when it stands in a known area with no public moongate: walking out is impossible.
export const strandedAt = (from: { x: number; y: number }) => {
  const here = areaHere(from);
  return here !== undefined && !gated.has(here);
};
// The area a moongate stands in.
export const gateArea = (gate: { x: number; y: number }) => areaOfPlace(gate);

// Finds the area of the spot it stands on, once per 16-tile cell: a walk to the nearest known
// places, the first that succeeds deciding. No known place within reach is an area of its own
// (-1): stranded, unless a moongate or teleporter is right here.
export async function locate(terrain: Terrain, at: { x: number; y: number; z: number }) {
  const key = cellKey(at);
  if (areaHere(at) !== undefined || !data.points.length) return areaHere(at);
  // The nearest place of each area around (up to six areas): the nearest few places alone can all
  // sit across water (Skara Brae seen from the shore) and make the mainland look like a pocket.
  const nearest = new Map<number, { p: Areas['points'][number]; d: number }>();
  for (const p of data.points) {
    const d = Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y));
    if (d > 300) continue;
    const known = nearest.get(p.area);
    if (!known || d < known.d) nearest.set(p.area, { p, d });
  }
  const near = [...nearest.values()].sort((a, b) => a.d - b.d).slice(0, 6);
  let found = -1;
  for (const { p } of near) {
    const range = p.kind === 'ground' ? 12 : 3;
    // Already there: an empty path is no failure.
    if (Math.max(Math.abs(at.x - p.x), Math.abs(at.y - p.y)) <= range) {
      found = p.area;
      break;
    }
    const path = await terrain.pathAsync(at, p, range).catch(() => null);
    const end = path?.at(-1);
    if (end && Math.max(Math.abs(end.x - p.x), Math.abs(end.y - p.y)) <= range) {
      found = p.area;
      break;
    }
  }
  // Nothing known within 300 tiles at all: the wilds, not a pocket; left unknown.
  if (!near.length) return undefined;
  cells.set(key, Math.floor((Date.now() + 2 * 3_600_000) / 1000) * 10_000 + found + 2);
  return found;
}
