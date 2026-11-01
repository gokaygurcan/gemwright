import type { PlayerSession } from '@gemwright/network/session';
import type { Position } from '@gemwright/network/world';

import { areaHere, areaOfPlace, gateArea, locate } from './areas';
import { Blocked } from './blocked';
import { type Gate, moongates, nearestGate } from './gates';
import { travelByMoongate } from './moongate';
import { distance } from './navigation';
import { recallFor } from './recall';
import type { Terrain } from './terrain';

type Goal = { x: number; y: number; z?: number };
type Context = {
  session: PlayerSession;
  terrain: Terrain;
  position: () => Position;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (note: string) => void;
};

async function surfaceArea(ctx: Context, point: Goal) {
  const known = areaOfPlace(point) ?? areaHere(point);
  if (known !== undefined) return known;
  const stand = ctx.terrain.stand(point.x, point.y, point.z ?? ctx.position().z);
  return stand ? locate(ctx.terrain, stand) : undefined;
}

// A gate belongs to the destination's connected land, even when another gate is closer across water.
export function destinationGate(point: Goal, area?: number): Gate | undefined {
  if (area === undefined) return nearestGate(point);
  return (Object.keys(moongates) as Gate[])
    .filter((gate) => gateArea(moongates[gate]) === area)
    .sort((a, b) => distance(point, moongates[a]) - distance(point, moongates[b]))[0];
}

export async function travelJourney(
  ctx: Context,
  goal: Goal,
  range: number,
  walk: (goal: Goal, range: number) => Promise<void>
): Promise<void> {
  const surface = async (point: Goal, reach: number): Promise<void> => {
    if (distance(ctx.position(), point) <= 32) return walk(point, reach);
    const here = await surfaceArea(ctx, ctx.position());
    const there = await surfaceArea(ctx, point);
    const gate = destinationGate(point, there);
    const crossArea = here !== undefined && there !== undefined && here !== there;
    const transit = async () => {
      if (await recallFor(ctx.session)?.(point)) return;
      if (!gate) throw new Blocked('unreachable', `No public route into the area at ${point.x},${point.y}`);
      await travelByMoongate({ ...ctx, navigate: walk }, gate);
    };
    if (crossArea) await transit();
    try {
      await walk(point, reach);
    } catch (error) {
      // A previously unknown water boundary: one gate trip, never repeated walking toward the sea.
      if (
        crossArea ||
        (here !== undefined && here === there) ||
        !gate ||
        distance(ctx.position(), moongates[gate]) <= 2 ||
        !(error instanceof Blocked) ||
        error.reason !== 'unreachable'
      )
        throw error;
      await transit();
      await walk(point, reach);
    }
  };
  const { dungeonWalker, inAnyDungeon } = await import('./dungeon-tools');
  const { floorAt } = await import('./dungeons');
  const site = { ...goal, z: goal.z ?? ctx.position().z };
  const here = inAnyDungeon(ctx.position());
  const there = inAnyDungeon(site);
  const sameFloor = here && here === there && floorAt(here, ctx.position()) === floorAt(here, site);
  if ((here || there) && !sameFloor) {
    const walker = dungeonWalker({ ...ctx, navigate: surface }, () => false);
    await walker.travelTo(site, range);
    return;
  }
  if (sameFloor) return walk(goal, range);
  return surface(goal, range);
}
