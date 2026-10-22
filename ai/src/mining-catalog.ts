import type { Point, Terrain } from './terrain';

export interface MiningCandidate extends Point {
  id: number;
  graphic: number;
  floor: boolean;
}
const catalogs = new WeakMap<Terrain, Map<string, Promise<MiningCandidate[]>>>();
const caveFloors = new Set(Array.from({ length: 21 }, (_, i) => 0x053b + i));
export function miningCatalog(
  terrain: Terrain,
  origin: Point,
  area: { x: number; y: number } | null
): Promise<MiningCandidate[]> {
  let cache = catalogs.get(terrain);
  if (!cache) {
    cache = new Map();
    catalogs.set(terrain, cache);
  }
  const center = area ?? { x: Math.floor(origin.x / 128) * 128, y: Math.floor(origin.y / 128) * 128 };
  const radius = area ? 100 : 308;
  const key = `${center.x},${center.y},${radius}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const candidates: MiningCandidate[] = [];
      let slice = performance.now();
      for (let x = Math.max(1, center.x - radius); x <= Math.min(7165, center.x + radius); x++) {
        for (let y = Math.max(1, center.y - radius); y <= Math.min(4093, center.y + radius); y++) {
          const land = terrain.cell(x, y).land;
          const name = terrain.tile(land.id).name;
          if (/^(rock|cave|cave floor)$/i.test(name))
            candidates.push({ ...land, graphic: 0, floor: /^cave/i.test(name) });
        }
        if (performance.now() - slice > 2) {
          await Bun.sleep(1);
          slice = performance.now();
        }
      }
      for (const floor of terrain.findStatics(caveFloors, { ...center, z: 0 }, radius))
        candidates.push({ ...floor, graphic: floor.id, floor: true });
      return candidates;
    })();
    const oldest = cache.keys().next().value;
    if (cache.size >= 8 && oldest !== undefined) cache.delete(oldest);
    cache.set(key, pending);
    pending.catch(() => cache?.delete(key));
  }
  return pending;
}
