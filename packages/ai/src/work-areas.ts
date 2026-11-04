import { readFileSync } from 'node:fs';

import { moongates, nearestGate } from './gates';
import { travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { recallFor } from './recall';

export interface WorkArea {
  city: string;
  x: number;
  y: number;
  // Share of residents relative to the other areas of the same kind (lore: Minoc mines, Yew woods).
  weight?: number;
  // City that sells this area's tools when its own does not.
  toolCity?: string;
}
// Each town's share of each kind of work (world/world.json, `workAreas`); where the work lies is
// read from the map at start (work-area-build.ts).
export const workAreaWeights = (
  JSON.parse(readFileSync(new URL('../world/world.json', import.meta.url), 'utf8')) as {
    workAreas: { schemaVersion: number; mining: Record<string, number>; woods: Record<string, number> };
  }
).workAreas;
if (workAreaWeights.schemaVersion !== 2) throw new Error('Unsupported work-area weights');
const catalog: Record<'mining' | 'woods', WorkArea[]> = { mining: [], woods: [] };
export function useWorkAreas(kind: 'mining' | 'woods', areas: WorkArea[]) {
  catalog[kind] = areas;
}

// A stable, weighted per-resident pick, so the population spreads the way the lore suggests.
// `usable` lets the caller demand the district's town support the work (a miner's bank and forge):
// residents are then assigned among those districts only, never to a dead end.
export function workArea(
  kind: 'mining' | 'woods',
  key: string,
  home?: string,
  usable?: (area: WorkArea) => boolean,
  near?: { x: number; y: number }
): WorkArea {
  // The areas of the town it works from (towns.ts) come first, its own reserved ones (weight 0:
  // New Haven's mountains and woods) included; the weighted pick spreads residents among them.
  const usableAreas = usable ? catalog[kind].filter((area) => usable(area)) : catalog[kind];
  const local = home ? usableAreas.filter((a) => a.city.toLowerCase() === home.toLowerCase()) : [];
  const own = local.find((a) => a.weight === 0);
  if (own) return own;
  // A town without such an area: the nearest one elsewhere, never a random trip across the land.
  const open = usableAreas.filter((a) => a.weight !== 0);
  if (!local.length && near && open.length)
    return open.reduce((best, a) => (distance(near, a) < distance(near, best) ? a : best));
  const qualified = local.length ? local : open;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const areas = qualified.length ? qualified : catalog[kind];
  const total = areas.reduce((sum, a) => sum + (a.weight ?? 1), 0);
  let roll = hash % total;
  const area = areas.find((a) => {
    roll -= a.weight ?? 1;
    return roll < 0;
  });
  if (!area) throw new Error(`No ${kind} areas configured`);
  return area;
}

// Every configured area of a kind (side-gathering.ts: the nearest one to a side trade).
export const workAreas = (kind: 'mining' | 'woods'): readonly WorkArea[] => catalog[kind];

// From another region, take the moongate nearest the destination before walking, as players do.
export async function reachRegion(
  ctx: Pick<MountContext, 'session' | 'position' | 'navigate' | 'phase'>,
  point: { x: number; y: number }
) {
  if (distance(ctx.position(), point) <= 300) return;
  // A caster with a rune marked near there recalls instead (recall.ts).
  if (await recallFor(ctx.session)?.(point)) return;
  const gate = nearestGate(point);
  if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
}
