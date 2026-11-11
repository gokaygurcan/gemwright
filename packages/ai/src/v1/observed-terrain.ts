import { createHash } from 'node:crypto';

import type { PlayerSession } from '@gemwright/network/session';

import { type GeometrySnapshot, geometryView } from '../geometry';
import type { Terrain } from '../terrain';
import { isDoor } from './doors';
import { expandDesign, MultiAssets } from './multi-assets';

const assets = new Map<string, MultiAssets>();
const views = new WeakMap<PlayerSession, WeakMap<Terrain, Terrain>>();

export function observedTerrain(base: Terrain, session: PlayerSession): Terrain {
  let owned = views.get(session);
  if (!owned) {
    owned = new WeakMap();
    views.set(session, owned);
  }
  const existing = owned.get(base);
  if (existing) return existing;
  if (!base.directory || !base.cell || !base.tile) return base;
  const multi = assets.get(base.directory) ?? new MultiAssets(base.directory);
  assets.set(base.directory, multi);
  let geometryRevision = 0,
    revision = -1;
  let facet = session.world.map,
    signature = '',
    scene = base;
  const observedItems = new Set<number>();
  session.world.observations.subscribe(
    (change) => {
      const changed =
        change.entities.some((id) => session.world.entities.get(id)?.kind === 'item') ||
        change.removed.some((id) => observedItems.has(id)) ||
        change.contexts.some((id) => session.world.houseRevisions.has(id) || observedItems.has(id)) ||
        change.fields.includes('map');
      if (changed) geometryRevision++;
    },
    (error) => {
      throw error;
    }
  );
  const sync = () => {
    if (revision === geometryRevision && facet === session.world.map) return scene;
    const observedRevision = geometryRevision;
    observedItems.clear();
    const snapshot: GeometrySnapshot = { revision: '', tiles: [], houses: [] };
    const identity: string[] = [`map:${session.world.map}`];
    for (const entity of session.world.entities.values()) {
      const at = entity.position;
      if (
        entity.kind !== 'item' ||
        !at ||
        entity.parent !== undefined ||
        (entity.facet !== undefined && entity.facet !== session.world.map)
      )
        continue;
      observedItems.add(entity.serial);
      if (entity.multi) {
        const foundation = multi.components(entity.graphic);
        const design = session.world.houseDesigns.get(entity.serial);
        const expected = session.world.houseRevisions.get(entity.serial);
        // A known newer design invalidates the old one immediately; its geometry is unknown until received.
        const current = design && design.revision === expected ? design : undefined;
        if (!foundation.length)
          throw new Error(`House multi 0x${entity.graphic.toString(16)} is missing from the deployed client assets`);
        const parts = current ? expandDesign(current.planes, foundation) : foundation;
        identity.push(
          `${entity.serial}:${entity.graphic}:${at.x},${at.y},${at.z}:${expected ?? 'standard'}:${current?.revision ?? 'pending'}`
        );
        const placed = parts.map((p) => ({ ...p, x: at.x + p.x, y: at.y + p.y, z: at.z + p.z }));
        snapshot.tiles.push(...placed.filter((p) => !isDoor(p.id, base)));
        const footprint = [...foundation, ...parts].map((p) => ({ x: at.x + p.x, y: at.y + p.y }));
        if (footprint.length)
          snapshot.houses?.push({
            serial: entity.serial,
            minX: Math.min(...footprint.map((p) => p.x)),
            maxX: Math.max(...footprint.map((p) => p.x)),
            minY: Math.min(...footprint.map((p) => p.y)),
            maxY: Math.max(...footprint.map((p) => p.y)) + Number(expected !== undefined),
            unknown: expected !== undefined && !current
          });
      } else {
        const tile = base.tile(entity.graphic, true);
        if (!(tile.flags & (0x40 | 0x200 | 0x400)) && !isDoor(entity.graphic, base)) continue;
        identity.push(`${entity.serial}:${entity.graphic}:${at.x},${at.y},${at.z}`);
        // Doors remain traversable in the geometric route; the navigator opens or rejects them.
        if (!isDoor(entity.graphic, base)) snapshot.tiles.push({ id: entity.graphic, x: at.x, y: at.y, z: at.z });
      }
    }
    snapshot.revision = createHash('sha256').update(identity.sort().join('|')).digest('hex');
    if (snapshot.revision !== signature) {
      signature = snapshot.revision;
      scene = geometryView(base, snapshot);
    }
    revision = observedRevision;
    facet = session.world.map;
    return scene;
  };
  const view = Object.create(base) as Terrain;
  Object.defineProperty(view, 'geometry', { get: () => sync().geometry });
  view.cell = (x, y) => sync().cell(x, y);
  view.path = (...args) => sync().path(...args);
  view.pathAsync = (...args) => sync().pathAsync(...args);
  owned.set(base, view);
  owned.set(view, view);
  return view;
}
