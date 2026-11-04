import { harvestTiles } from '@gemwright/common/game/rules';

import { serviceLocations } from './locations';
import { treeStatics } from './lumber-trees';
import type { Terrain } from './terrain';
import { useWorkAreas, type WorkArea, workAreaWeights } from './work-areas';

const rock = new Set(harvestTiles.rock.land);
const RADIUS = 300;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// Where tiles crowd most near a bank: 16-tile blocks scored by the tiles in and around them, nearer
// blocks first; the centre is the middle of that crowd.
function densest(points: { x: number; y: number }[], bank: { x: number; y: number }) {
  const blocks = new Map<string, { x: number; y: number }[]>();
  for (const p of points) {
    const key = `${p.x >> 4},${p.y >> 4}`;
    const block = blocks.get(key) ?? [];
    block.push(p);
    blocks.set(key, block);
  }
  let best: { score: number; around: { x: number; y: number }[] } | undefined;
  for (const key of blocks.keys()) {
    const [bx = 0, by = 0] = key.split(',').map(Number);
    const around = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => blocks.get(`${bx + dx},${by + dy}`) ?? []));
    const score = around.length / (1 + distance({ x: bx * 16 + 8, y: by * 16 + 8 }, bank) / 150);
    if (!best || score > best.score) best = { score, around };
  }
  return best && { x: median(best.around.map((p) => p.x)), y: median(best.around.map((p) => p.y)) };
}

// Each weighted town's mines (ServUO Mining.cs mountain and cave land) and woods (Lumberjacking.cs
// trees) from the client's map, near its bank; a town that sells no mining tools sends its miners to
// the nearest one that does.
export function buildWorkAreas(terrain: Terrain) {
  const bank = (city: string) => serviceLocations(city, 'banker')[0];
  const toolTown = (city: string) => {
    if (serviceLocations(city, 'mining-tools').length) return undefined;
    const from = bank(city);
    const towns = Object.keys(workAreaWeights.mining).concat(Object.keys(workAreaWeights.woods));
    return from
      ? towns
          .filter((town) => serviceLocations(town, 'mining-tools').length && bank(town))
          .sort((a, b) => distance(from, bank(a) ?? from) - distance(from, bank(b) ?? from))[0]
      : undefined;
  };
  const areas = (kind: 'mining' | 'woods', tiles: (at: { x: number; y: number }) => { x: number; y: number }[]) =>
    Object.entries(workAreaWeights[kind]).flatMap(([city, weight]): WorkArea[] => {
      const at = bank(city);
      const centre = at && densest(tiles(at), at);
      if (!centre) return [];
      const tools = kind === 'mining' ? toolTown(city) : undefined;
      return [{ city, ...centre, weight, ...(tools && { toolCity: tools }) }];
    });
  useWorkAreas(
    'mining',
    areas('mining', (at) => {
      const found: { x: number; y: number }[] = [];
      for (let x = Math.max(1, at.x - RADIUS); x <= Math.min(5119, at.x + RADIUS); x++)
        for (let y = Math.max(1, at.y - RADIUS); y <= Math.min(4095, at.y + RADIUS); y++)
          if (rock.has(terrain.cell(x, y).land.id)) found.push({ x, y });
      return found;
    })
  );
  useWorkAreas(
    'woods',
    areas('woods', (at) => terrain.findStatics(treeStatics, { ...at, z: 0 }, RADIUS))
  );
}
