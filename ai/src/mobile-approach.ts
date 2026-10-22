import type { FighterContext } from './fighter-context';

type MobileApproachContext = Pick<FighterContext, 'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial'>;

import { distance } from './navigation';
import type { Entity, Position } from './protocol/world';
import type { Point, Terrain } from './terrain';

export function connectedInteractionTile(terrain: Terrain, standing: Point, target: Point): boolean {
  if (Math.abs(standing.x - target.x) + Math.abs(standing.y - target.y) !== 1 || Math.abs(standing.z - target.z) > 2)
    return false;
  const step = terrain.stand(target.x, target.y, standing.z, standing);
  if (!step || Math.abs(step.z - target.z) > 2) return false;
  for (const point of [standing, target]) {
    if (
      terrain.cell(point.x, point.y).statics.some((item) => {
        const tile = terrain.tile(item.id, true);
        return (
          (tile.flags & (0x10 | 0x40 | 0x1000 | 0x2000)) !== 0 &&
          item.z < point.z + 16 &&
          item.z + tile.height > point.z
        );
      })
    )
      return false;
  }
  return true;
}

export async function approachMobile(ctx: MobileApproachContext, serial: number): Promise<Entity> {
  const { session, terrain, position, navigate, check } = ctx;
  const clear = (standing: Point, target: Point) =>
    connectedInteractionTile(terrain, standing, target) &&
    ![...session.world.entities.values()].some((item) => {
      if (item.kind !== 'item' || !item.position || distance(item.position, standing) > 1) return false;
      if (![standing, target].some((p) => p.x === item.position?.x && p.y === item.position?.y)) return false;
      const tile = terrain.tile(item.graphic, true);
      return (
        (tile.flags & (0x10 | 0x40 | 0x1000 | 0x2000)) !== 0 &&
        item.position.z < standing.z + 16 &&
        item.position.z + tile.height > standing.z
      );
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    const mobile = session.world.entities.get(serial);
    if (!mobile?.position || mobile.kind !== 'mobile') throw new Error('Interaction mobile is no longer observed');
    const target: Position = { ...mobile.position };
    if (clear(position(), target)) return mobile;
    const occupied = new Set(
      [...session.world.entities.values()]
        .filter(
          (item) =>
            item.serial !== ctx.serial &&
            item.position &&
            (item.kind === 'mobile' ||
              (terrain.tile(item.graphic, true).flags & 0x40 && !(terrain.tile(item.graphic, true).flags & 0x20000000)))
        )
        .flatMap((item) => (item.position ? [`${item.position.x},${item.position.y}`] : []))
    );
    const candidates: { point: Point; length: number }[] = [];
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0]
    ] as const) {
      const point = terrain.stand(target.x + dx, target.y + dy, target.z, target);
      if (!point || occupied.has(`${point.x},${point.y}`) || !clear(point, target)) continue;
      const path = await terrain.pathAsync(position(), point, 0, occupied, point.z, session.signal);
      if (path) candidates.push({ point, length: path.length });
    }
    candidates.sort((a, b) => a.length - b.length);
    const best = candidates[0];
    if (!best) throw new Error(`No unobstructed same-side approach to ${target.x},${target.y}`);
    // Range zero makes the door-aware navigator enter the chosen interaction tile.
    await navigate(best.point, 0);
  }
  const current = session.world.entities.get(serial);
  if (!current?.position || !clear(position(), current.position))
    throw new Error('Mobile moved behind an obstruction during approach');
  return current;
}

// VendorBuyEntry/VendorSellEntry use range 8; the server validates the offered action and transaction.
export async function approachVendor(ctx: MobileApproachContext, serial: number): Promise<Entity> {
  for (let attempt = 0; attempt < 3; attempt++) {
    ctx.check();
    const mobile = ctx.session.world.entities.get(serial);
    if (!mobile?.position || mobile.kind !== 'mobile') throw new Error('Interaction mobile is no longer observed');
    if (distance(ctx.position(), mobile.position) <= 8 && Math.abs(ctx.position().z - mobile.position.z) <= 8)
      return mobile;
    await ctx.navigate(mobile.position, 6);
  }
  throw new Error('Vendor moved outside the supported interaction range');
}
