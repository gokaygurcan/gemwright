import { FACET_SIZES } from '@gemwright/common/assets/facet';
import { MAPS } from '@gemwright/common/game/maps';

import type { Analysis } from './analysis';
import { itemLabel } from './owners';
import type { readLasting } from './trouble';

// What the world map (web/map.tsx) draws over a facet: player characters and residents where they
// are (or logged out), houses and boats, and from the resident database the failed-walk cells
// and the day's deaths. The residents live on Trammel and the AI keeps those places without a
// facet, so trouble and deaths are drawn on Trammel only.
export type MarkerKind = 'resident' | 'player' | 'house' | 'trouble' | 'death';

export interface Marker {
  kind: MarkerKind;
  x: number;
  y: number;
  label: string;
  href?: string;
}

export interface MapResponse {
  map: number;
  name: string;
  width: number;
  height: number;
  markers: Marker[];
  // Whether the server has the client files to draw the map tiles.
  drawn?: boolean;
}

const RESIDENT_FACET = 1;

export function mapData(a: Analysis, map: number, lasting: ReturnType<typeof readLasting>): MapResponse | undefined {
  const size = FACET_SIZES[map];
  if (!size) return undefined;
  const markers: Marker[] = [];
  for (const m of a.world.mobiles.values())
    if (m.player && m.map === map)
      markers.push({
        kind: a.residents.has(m.serial) ? 'resident' : 'player',
        x: m.location.x,
        y: m.location.y,
        label: `${m.name ?? 'Unnamed'}${m.online ? '' : ' (logged out)'}`,
        href: `/mobile/${m.serial}`
      });
  for (const i of a.world.items.values())
    if (i.parent === undefined && i.map === map && i.type.startsWith('Server.Multis.'))
      markers.push({ kind: 'house', x: i.location.x, y: i.location.y, label: itemLabel(i), href: `/item/${i.serial}` });
  if (map === RESIDENT_FACET && lasting) {
    const cells = new Map<string, number>();
    for (const [key] of lasting.trouble ?? []) {
      const cell = key.split('|')[0] ?? '';
      cells.set(cell, (cells.get(cell) ?? 0) + 1);
    }
    for (const [cell, n] of cells) {
      const [cx = 0, cy = 0] = cell.split(',').map(Number);
      markers.push({
        kind: 'trouble',
        x: cx * 8 + 4,
        y: cy * 8 + 4,
        label: `${n} failed walk${n === 1 ? '' : 's'}${n >= 3 ? ', avoided by routes' : ''}`,
        href: '/trouble'
      });
    }
    for (const [key] of lasting['death-log'] ?? []) {
      const [resident = '', place = '', cause = 'unknown'] = key.split('|');
      const [x = 0, y = 0] = place.split(',').map(Number);
      const m = a.world.mobiles.get(Number(resident));
      markers.push({
        kind: 'death',
        x,
        y,
        label: `${m?.name ?? resident} died near ${cause}`,
        href: `/mobile/${resident}`
      });
    }
  }
  return { map, name: MAPS[map] ?? String(map), width: size[0], height: size[1], markers };
}
