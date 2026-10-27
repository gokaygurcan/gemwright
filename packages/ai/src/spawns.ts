import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The spawners of a stock ServUO world (Spawns/<facet>.xml): where each kind of creature or NPC
// appears, the same on every shard built from that source. Offline builders read these instead
// of a world save, so the catalogues they make fit any shard, not ours alone.
export interface Spawner {
  x: number;
  y: number;
  map: string;
  // The spawner's MaxCount, shared by all its kinds.
  max: number;
  // Creature or NPC types, lower-cased as ServUO matches them (Objects2 OBJ= entries).
  kinds: string[];
}

export function readSpawners(servuo: string, facet = 'trammel'): Spawner[] {
  const xml = readFileSync(join(servuo, `Spawns/${facet}.xml`), 'utf8');
  return [...xml.matchAll(/<Points>([\s\S]*?)<\/Points>/g)].map(([, point]) => {
    const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(point ?? '')?.[1] ?? '';
    const kinds = field('Objects2')
      .split(':OBJ=')
      .map((entry) => (entry.split(':')[0] ?? '').split('/')[0]?.trim().toLowerCase() ?? '')
      .filter(Boolean);
    return {
      x: Number(field('CentreX')),
      y: Number(field('CentreY')),
      map: field('Map'),
      max: Number(field('MaxCount')) || kinds.length,
      kinds
    };
  });
}

// Each spawner's kinds with their share of its MaxCount (at least one each).
export const shares = (s: Spawner) =>
  s.kinds.map((type) => ({ type, count: Math.max(1, Math.round(s.max / s.kinds.length)) }));

// ServUO Data/Regions.xml rectangles of a region, by name, on a facet.
export function regionRects(servuo: string, name: string, facet = 'Trammel') {
  const xml = readFileSync(join(servuo, 'Data/Regions.xml'), 'utf8');
  const start = xml.indexOf(`<Facet name="${facet}">`);
  const inFacet = xml.slice(start, xml.indexOf('</Facet>', start));
  // Its own rectangles only: those before any region nested inside it.
  const region =
    (new RegExp(`<region[^>]*name="${name}"[^>]*>([\\s\\S]*?)</region>`).exec(inFacet)?.[1] ?? '').split(
      '<region'
    )[0] ?? '';
  return [...region.matchAll(/<rect\s+([^>]*)\/>/g)].map(([, attrs]) => {
    const attr = (n: string) => Number(new RegExp(`${n}="(-?\\d+)"`).exec(attrs ?? '')?.[1]);
    return { x0: attr('x'), y0: attr('y'), x1: attr('x') + attr('width'), y1: attr('y') + attr('height') };
  });
}
