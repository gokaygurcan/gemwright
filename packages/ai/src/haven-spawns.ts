import { monsters } from './monster-reference';
import { alive } from './spawn-grounds';
import type { Spawner } from './spawns';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const byType = new Map(monsters.map((m) => [m.type.toLowerCase(), m]));
const hostile = (type: string) => !!byType.get(type)?.aggressive;
const label = (type: string) => type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const inside = (box: Box, p: { x: number; y: number }) =>
  p.x >= box.x0 && p.x < box.x1 && p.y >= box.y0 && p.y < box.y1;
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;

// Haven Island's monster grounds outside town, from its spawners: creatures that attack on sight,
// by 30-tile cell, at least four of them.
export function havenFromSpawners(spawners: Spawner[], island: Box, town: Box) {
  const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
  for (const spawner of spawners) {
    const { x, y } = spawner;
    if (spawner.map !== 'Trammel' || !inside(island, spawner)) continue;
    const kinds = alive(spawner, hostile);
    if (!kinds.length || inside(town, spawner)) continue;
    const key = `${Math.floor(x / 30)},${Math.floor(y / 30)}`;
    const cell = cells.get(key) ?? { xs: [], ys: [], kinds: new Map<string, number>() };
    cells.set(key, cell);
    cell.xs.push(x);
    cell.ys.push(y);
    for (const [kind, count] of kinds) {
      const type = byType.get(kind)?.type ?? kind;
      cell.kinds.set(type, (cell.kinds.get(type) ?? 0) + count);
    }
  }
  const grounds = [...cells.values()]
    .filter((c) => [...c.kinds.values()].reduce((n, v) => n + v, 0) >= 4)
    .map((c) => {
      const kinds = [...c.kinds].sort((a, b) => b[1] - a[1]);
      return {
        name: `${kinds
          .slice(0, 2)
          .map(([k]) => label(k))
          .join(' and ')} near ${median(c.xs)},${median(c.ys)}`,
        center: { x: median(c.xs), y: median(c.ys) },
        radius: 30,
        creatures: Object.fromEntries(kinds)
      };
    })
    .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
  return { grounds };
}
