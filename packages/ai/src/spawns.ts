import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRegions, type Rect, type Region } from '@gemwright/common/game/regions';

import { type Placement, parseDecoration } from './decoration';
import { type Link, parseTeleporters } from './links';

// The spawners of a ServUO world (Spawns/<facet>.xml, what `[createworld` places): where each kind of
// creature or NPC appears. Spawners rarely move once placed. Offline builders read a stock ServUO's
// for the bundled catalogues; the service reads the shard's own at start (readShardWorld), all 6,465
// of a full world in a few tens of milliseconds: nothing is learned piecemeal and nothing grows.
export interface Spawner {
  name: string;
  x: number;
  y: number;
  z: number;
  map: string;
  // How far what it spawns may roam from it (XmlSpawner HomeRange, <Range>).
  range: number;
  // The spawner's MaxCount, shared by all its kinds.
  max: number;
  // Creature or NPC types, lower-cased as ServUO matches them (Objects2 OBJ= entries).
  kinds: string[];
  // Each type's MX: at most this many of it at once.
  mx: Record<string, number>;
}

export function parseSpawners(xml: string): Spawner[] {
  return [...xml.matchAll(/<Points>([\s\S]*?)<\/Points>/g)].map(([, point]) => {
    const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(point ?? '')?.[1] ?? '';
    const entries = field('Objects2')
      .split(':OBJ=')
      .map((entry) => ({
        type: (entry.split(':')[0] ?? '').split('/')[0]?.trim().toLowerCase() ?? '',
        mx: Number(/MX=(\d+)/.exec(entry)?.[1] ?? 1)
      }))
      .filter((entry) => entry.type);
    const mx: Record<string, number> = {};
    for (const entry of entries) mx[entry.type] = (mx[entry.type] ?? 0) + entry.mx;
    return {
      name: field('Name'),
      x: Number(field('CentreX')),
      y: Number(field('CentreY')),
      z: Number(field('CentreZ')),
      map: field('Map'),
      range: Number(field('Range')) || 0,
      max: Number(field('MaxCount')) || entries.length,
      kinds: entries.map((entry) => entry.type),
      mx
    };
  });
}

export const readSpawners = (servuo: string, facet = 'trammel'): Spawner[] =>
  parseSpawners(readFileSync(join(servuo, `Spawns/${facet}.xml`), 'utf8'));

// Each spawner's kinds with their share of its MaxCount (at least one each).
export const shares = (s: Spawner) =>
  s.kinds.map((type) => ({ type, count: Math.max(1, Math.round(s.max / s.kinds.length)) }));

// ServUO Data/Regions.xml rectangles of a region, by name, on a facet.
export type { Rect } from '@gemwright/common/game/regions';

const trammel = (xml: string) => parseRegions(xml).filter((region) => region.facet === 'Trammel');
// Trammel's towns, guarded places and dungeons (Data/Regions.xml): no hunting ground lies in one.
export function trammelRegions(regionsXml: string): Rect[] {
  return trammel(regionsXml)
    .filter((region) => ['GuardedRegion', 'TownRegion', 'DungeonRegion', 'NoHousingRegion'].includes(region.type))
    .flatMap((region) => region.rects);
}
// Trammel's towns (Data/Regions.xml TownRegion), each by its own rectangles (not those of the
// regions inside it): which town a place belongs to.
export type Town = Pick<Region, 'name' | 'rects'>;
export const townRegions = (regionsXml: string): Town[] =>
  trammel(regionsXml).filter((region) => region.type === 'TownRegion');
// Every named Trammel region (Haven Island, New Haven, a dungeon) by its own rectangles.
export const namedRegions = (regionsXml: string): Region[] => trammel(regionsXml);

export interface ShardWorld {
  spawners: Spawner[];
  regions: Rect[];
  towns: Town[];
  // Every named region, towns included (Haven Island).
  named: Town[];
  // Overland decoration (x < 5120): forges, ankhs.
  decoration: Placement[];
  teleporters: Link[];
}
// Every file the world folder must hold (start.sh waits for them).
export const WORLD_FILES = ['Spawns', 'Regions.xml', 'Decoration', 'teleporters.csv'];

// The shard's world files as the deployment keeps them (`<data>/world`: Spawns/**/*.xml, Regions.xml,
// Decoration/**/*.cfg and teleporters.csv), or nothing when any is missing.
export function readShardWorld(directory: string): ShardWorld | undefined {
  if (WORLD_FILES.some((file) => !existsSync(join(directory, file)))) return undefined;
  const files = (folder: string, extension: string) =>
    readdirSync(join(directory, folder), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.toLowerCase().endsWith(extension))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(directory, folder, name), 'utf8') }));
  return {
    spawners: files('Spawns', '.xml').flatMap(({ text }) => parseSpawners(text)),
    regions: trammelRegions(readFileSync(join(directory, 'Regions.xml'), 'utf8')),
    towns: townRegions(readFileSync(join(directory, 'Regions.xml'), 'utf8')),
    named: namedRegions(readFileSync(join(directory, 'Regions.xml'), 'utf8')),
    decoration: files('Decoration', '.cfg')
      .flatMap(({ text }) => parseDecoration(text))
      .filter((p) => p.x < 5120),
    teleporters: parseTeleporters(readFileSync(join(directory, 'teleporters.csv'), 'utf8'))
  };
}
