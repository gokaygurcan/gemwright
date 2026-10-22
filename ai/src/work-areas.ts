import { readFileSync } from 'node:fs';

import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';

interface WorkArea {
  city: string;
  x: number;
  y: number;
  // Share of residents relative to the other areas of the same kind (lore: Minoc mines, Yew woods).
  weight?: number;
  // City that sells this area's tools when its own does not.
  toolCity?: string;
}
// Work areas live in the world configuration (world/world.json, `workAreas`).
const catalog = (
  JSON.parse(readFileSync(new URL('../world/world.json', import.meta.url), 'utf8')) as {
    workAreas: { schemaVersion: number; facet: number; mining: WorkArea[]; woods: WorkArea[] };
  }
).workAreas;
if (catalog.schemaVersion !== 1 || catalog.facet !== 1) throw new Error('Unsupported work-area catalog');

// A stable, weighted per-resident pick, so the population spreads the way the lore suggests.
export function workArea(kind: 'mining' | 'woods', key: string): WorkArea {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const areas = catalog[kind];
  const total = areas.reduce((sum, a) => sum + (a.weight ?? 1), 0);
  let roll = hash % total;
  const area = areas.find((a) => {
    roll -= a.weight ?? 1;
    return roll < 0;
  });
  if (!area) throw new Error(`No ${kind} areas configured`);
  return area;
}

// From another region, take the moongate nearest the destination before walking, as players do.
export async function reachRegion(
  ctx: Pick<MountContext, 'session' | 'position' | 'navigate' | 'phase'>,
  point: { x: number; y: number }
) {
  if (distance(ctx.position(), point) <= 300) return;
  const gate = nearestGate(point);
  if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
}
