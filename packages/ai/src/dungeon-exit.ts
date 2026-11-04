import type { PlayerSession } from '@gemwright/network/session';

import { knownPoints } from './areas';
import { allLinks, type Link, teleporterTiles } from './links';
import { directionTo, type Point, type Terrain } from './terrain';

// Dungeons and mines lie outside the open world (x 5120 and beyond), each a closed space left only
// by its teleporters. Someone inside (alive, or a ghost looking for a healer) first finds the way up
// and out: the section it stands in (area-build.ts, places joined by walking alone: a level), then
// level by level through the teleporters to the open world. Only out there does it go anywhere.
export const OPEN_WORLD_EDGE = 5120;
export const inDungeon = (p: { x: number; y: number }) => p.x >= OPEN_WORLD_EDGE;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const sectionOf = (p: { x: number; y: number }) =>
  knownPoints().find((point) => point.x === p.x && point.y === p.y)?.section;

// The section a spot inside belongs to: the nearest known place of each section around (a nearer
// section can lie behind rock, as Ice's teleporters do beside New Haven's mine), the first a walk
// reaches deciding.
export async function sectionHere(terrain: Terrain, at: Point) {
  const nearest = new Map<number, Point>();
  for (const p of knownPoints()) {
    if (!inDungeon(p) || p.section === undefined || distance(p, at) > 300) continue;
    const known = nearest.get(p.section);
    if (!known || distance(p, at) < distance(known, at)) nearest.set(p.section, { ...p, z: 0 });
  }
  const near = [...nearest]
    .map(([section, p]) => ({ ...p, section }))
    .sort((a, b) => distance(a, at) - distance(b, at))
    .slice(0, 8);
  for (const p of near) {
    if (distance(p, at) <= 1) return p.section;
    const path = await terrain.pathAsync(at, p, 1).catch(() => null);
    const end = path?.at(-1);
    if (end && distance(end, p) <= 1) return p.section;
  }
  return undefined;
}

// The teleporters out from a section, in order: the fewest levels to the open world.
export function routeOut(section: number, links: readonly Link[] = allLinks()): Link[] | undefined {
  const queue: { section: number; route: Link[] }[] = [{ section, route: [] }];
  const seen = new Set([section]);
  for (let i = 0; i < queue.length; i++) {
    const step = queue[i];
    if (!step) continue;
    for (const link of links) {
      if (sectionOf(link.from) !== step.section) continue;
      const route = [...step.route, link];
      if (!inDungeon(link.to)) return route;
      const next = sectionOf(link.to);
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        queue.push({ section: next, route });
      }
    }
  }
  return undefined;
}

// Onto a teleporter and through it. The server sends only who steps onto it (ServUO
// Teleporter.OnMoveOver): one already standing there (arrived through it, or fell on it) steps off
// and back on, each step tried until it moves (a step in a new direction first only turns).
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
export async function takeLink(
  ctx: {
    session: PlayerSession;
    terrain: Terrain;
    position: () => Point;
    navigate: (goal: Point, range: number) => Promise<unknown>;
  },
  link: Link
) {
  const { session, terrain, position } = ctx;
  const through = () => distance(position(), link.to) <= 3;
  const step = async (direction: number) => {
    const from = position();
    for (let tries = 0; tries < 3 && distance(position(), from) === 0; tries++) await session.walk(direction);
  };
  // Beside it first, then one plain step on: a walk with the tile as its goal would go on trying to
  // reach it after the teleporter had sent it away.
  if (distance(position(), link.from) > 1) await ctx.navigate(link.from, 1).catch(() => {});
  if (distance(position(), link.from) === 1) await step(directionTo(position(), link.from));
  else if (distance(position(), link.from) === 0) {
    const here = position();
    const aside = DX.findIndex((dx, direction) => {
      const to = { x: here.x + dx, y: here.y + (DY[direction] ?? 0) };
      return !teleporterTiles.has(`${to.x},${to.y}`) && !!terrain.stand(to.x, to.y, here.z, here);
    });
    if (aside < 0) return false;
    await step(aside);
    if (distance(position(), here) === 1) await step((aside + 4) & 7);
  }
  await session.waitFor(through, 'teleport', 4000).catch(() => {});
  return through();
}

// Up and out to the open world, level by level. False when no way out is known or it failed.
export async function leaveDungeon(
  ctx: Parameters<typeof takeLink>[0] & { phase: (phase: string, note: string) => void }
) {
  for (let levels = 0; levels < 12 && inDungeon(ctx.position()); levels++) {
    const section = await sectionHere(ctx.terrain, ctx.position());
    const link = section === undefined ? undefined : routeOut(section)?.[0];
    if (!link) return false;
    ctx.phase(
      'leaving-dungeon',
      `${inDungeon(link.to) ? 'Up' : 'Out'} through the teleporter at ${link.from.x},${link.from.y} to ${link.to.x},${link.to.y}`
    );
    if (!(await takeLink(ctx, link))) return false;
  }
  return !inDungeon(ctx.position());
}
