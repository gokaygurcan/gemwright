import type { PlayerSession } from '@gemwright/network/session';

import type { Town } from '../spawns';
import { outgrewYoung } from './progression';

// New Haven (Haven Island and its town from the shard's Regions.xml; its shops and monster grounds
// from the shard's own spawners, haven-spawns.ts): the island town where new players begin. Young
// residents (fewer than three skills at 100.0 base, progression.ts) favour it; nobody is held there.
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface HavenGround {
  name: string;
  center: { x: number; y: number };
  radius: number;
  creatures: Record<string, number>;
}
const none: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };
// Set at start from the shard's world files (shard-world.ts).
export const haven = { island: none, town: none, grounds: [] as HavenGround[] };
// The box around a region's own rectangles.
export function useHaven(regions: readonly Town[]) {
  const box = (name: string): Box => {
    const rects = regions.find((region) => region.name === name)?.rects ?? [];
    if (!rects.length) return none;
    return {
      x0: Math.min(...rects.map((r) => r.x)),
      y0: Math.min(...rects.map((r) => r.y)),
      x1: Math.max(...rects.map((r) => r.x + r.width)),
      y1: Math.max(...rects.map((r) => r.y + r.height))
    };
  };
  haven.island = box('Haven Island');
  haven.town = box(HAVEN_CITY);
}
export const HAVEN_CITY = 'New Haven';
const inside = (box: Box, p: { x: number; y: number }) =>
  p.x >= box.x0 && p.x < box.x1 && p.y >= box.y0 && p.y < box.y1;
export const onHaven = (point: { x: number; y: number }) => inside(haven.island, point);

// Any Young resident favours the island's grounds, taming spots and outings, as new players do; a
// favour in its choices, never a limit.
export const prefersHaven = (session: PlayerSession) => !outgrewYoung(session);
