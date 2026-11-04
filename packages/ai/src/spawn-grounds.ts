import { PLAIN_HUMAN_BODIES } from '@gemwright/common/game/bodies';

import { monsters } from './monster-reference';
import type { Rect, Spawner } from './spawns';

const byType = new Map(monsters.map((m) => [m.type.toLowerCase(), m]));
// Creatures worth hunting: known stats and not human-bodied (a brigand looks like a player). Ones
// that leave a passer-by alone count too: rats, rabbits and mongbats are where a resident with
// nothing starts, and a ground of only those is the first rung (skirmish.ts scrapTurn).
const huntable = (type: string) => {
  const m = byType.get(type);
  return !!m?.hits && !m.bodies.some((b) => PLAIN_HUMAN_BODIES.has(b)) && m.fame < 15000;
};
const typeName = (type: string) => byType.get(type)?.type ?? type;
const label = (type: string) =>
  (byType.get(type)?.name ?? byType.get(type)?.type ?? type).replace(/^(an?|the) /i, '').toLowerCase();

// How many of each kind (huntable by default) a spawner keeps alive: each kind's MX, scaled down when
// they add up to more than its MaxCount.
export function alive(spawner: Spawner, keep: (type: string) => boolean = huntable) {
  const kinds = Object.entries(spawner.mx).filter(([type]) => keep(type));
  const listed = kinds.reduce((n, [, mx]) => n + mx, 0);
  const scale = listed > spawner.max ? spawner.max / listed : 1;
  return kinds.map(([type, mx]) => [type, Math.max(1, Math.round(mx * scale))] as const);
}

export interface SpawnGround {
  name: string;
  center: { x: number; y: number };
  radius: number;
  creatures: Record<string, number>;
}

// The overland places on Trammel where creatures spawn, outside towns and dungeons: spawners grouped
// by 40-tile cell, a cell with at least six creatures a ground named after its commonest kinds. And
// each cemetery's creatures: its own graveyard spawner's (Graveyards#n) at their MX, else (Old Haven)
// every huntable spawn within `reach`. The radius alone lent Britain's graveyard the trolls and orcs
// of a spawner next to it, and kept novices away.
export function spawnGrounds(
  spawners: Spawner[],
  regions: Rect[],
  cemeteries: { name: string; center: { x: number; y: number } }[],
  reach: number
) {
  const trammel = spawners.filter((s) => s.map === 'Trammel');
  const inside = (x: number, y: number) =>
    regions.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  const cells = new Map<string, { xs: number[]; ys: number[]; kinds: Map<string, number> }>();
  for (const spawner of trammel) {
    const { x, y } = spawner;
    if (x >= 5120 || inside(x, y)) continue;
    const kinds = alive(spawner);
    if (!kinds.length) continue;
    const key = `${Math.floor(x / 40)},${Math.floor(y / 40)}`;
    const cell = cells.get(key) ?? { xs: [], ys: [], kinds: new Map<string, number>() };
    cells.set(key, cell);
    cell.xs.push(x);
    cell.ys.push(y);
    for (const [kind, count] of kinds) cell.kinds.set(kind, (cell.kinds.get(kind) ?? 0) + count);
  }
  const grounds: SpawnGround[] = [...cells.values()]
    .filter((cell) => [...cell.kinds.values()].reduce((n, v) => n + v, 0) >= 6)
    .map((cell) => {
      const x = Math.round(cell.xs.reduce((n, v) => n + v, 0) / cell.xs.length);
      const y = Math.round(cell.ys.reduce((n, v) => n + v, 0) / cell.ys.length);
      const kinds = [...cell.kinds].sort((a, b) => b[1] - a[1]);
      return {
        name: `${kinds
          .slice(0, 2)
          .map(([type]) => label(type))
          .join(' and ')} spawn near ${x},${y}`,
        center: { x, y },
        radius: 40,
        creatures: Object.fromEntries(kinds.map(([type, n]) => [typeName(type), n]))
      };
    })
    .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
  const near = (s: Spawner, center: { x: number; y: number }, range: number) =>
    Math.max(Math.abs(center.x - s.x), Math.abs(center.y - s.y)) <= range;
  const cemeteryCreatures: Record<string, Record<string, number>> = {};
  for (const cemetery of cemeteries) {
    const own = trammel.find((s) => s.name.startsWith('Graveyards#') && near(s, cemetery.center, 10));
    const creatures: Record<string, number> = {};
    for (const spawner of own ? [own] : trammel.filter((s) => near(s, cemetery.center, reach)))
      for (const [kind, count] of alive(spawner)) creatures[typeName(kind)] = (creatures[typeName(kind)] ?? 0) + count;
    if (Object.keys(creatures).length) cemeteryCreatures[cemetery.name] = creatures;
  }
  return { grounds, cemeteries: cemeteryCreatures };
}
