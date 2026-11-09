import type { PlayerSession } from '@gemwright/network/session';
import type { Position } from '@gemwright/network/world';

import { areaHere, areaOfPlace, gateArea, locate } from './areas';
import { Blocked } from './blocked';
import { dangerAhead } from './danger-response';
import { type Gate, gateOpen, moongates, nearestGate } from './gates';
import { lifeEvent } from './life-events';
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
    .filter((gate) => gateOpen(gate, point) && gateArea(moongates[gate]) === area)
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
    // Nearest to the destination's own gate, a trip through the gates would land it beside that same
    // gate: whatever a cell's label says, no gate helps, and the walk is all there is.
    const besideGate = !!gate && nearestGate(ctx.position()) === gate;
    const crossArea = !besideGate && here !== undefined && there !== undefined && here !== there;
    const entrance =
      here === undefined
        ? undefined
        : (Object.keys(moongates) as Gate[])
            .filter((candidate) => gateOpen(candidate, ctx.position()) && gateArea(moongates[candidate]) === here)
            .filter((candidate) => !dangerAhead(ctx.session, ctx.position(), moongates[candidate]))
            .sort((a, b) => distance(ctx.position(), moongates[a]) - distance(ctx.position(), moongates[b]))[0];
    const direct = distance(ctx.position(), point);
    const viaGate =
      entrance && gate && entrance !== gate
        ? distance(ctx.position(), moongates[entrance]) + distance(moongates[gate], point)
        : Infinity;
    const useGate = crossArea || (here !== undefined && there !== undefined && viaGate < direct);
    const route = {
      destination: point,
      fromArea: here ?? null,
      toArea: there ?? null,
      entrance: useGate ? (entrance ?? null) : null,
      exit: useGate ? (gate ?? null) : null,
      directDistance: direct,
      gateWalkingDistance: Number.isFinite(viaGate) ? viaGate : null,
      reason: crossArea
        ? 'Different connected areas require transit'
        : useGate
          ? 'Gate pair reduces walking'
          : 'Direct walking needs no useful gate pair'
    };
    lifeEvent(ctx.session, 'route', 'started', route);
    ctx.log(
      `Route to ${point.x},${point.y}: ${route.reason}${useGate ? ` (${entrance ?? '?'} to ${gate ?? '?'})` : ''}`
    );
    const transit = async () => {
      if (await recallFor(ctx.session)?.(point)) return;
      if (!gate) throw new Blocked('unreachable', `No public route into the area at ${point.x},${point.y}`);
      await travelByMoongate({ ...ctx, navigate: walk }, gate);
    };
    if (useGate) await transit();
    try {
      await walk(point, reach);
    } catch (error) {
      // A previously unknown water boundary: one gate trip, never repeated walking toward the sea.
      if (
        useGate ||
        besideGate ||
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
