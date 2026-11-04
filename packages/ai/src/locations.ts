import { graphicsOfKinds } from '@gemwright/common/game/rules';

import { withinReach } from './areas';
import { isForge, type Placement } from './decoration';
import { servicesOf } from './shops';
import type { Spawner, Town } from './spawns';
import { reachableFrom } from './unreachable';

export type ServiceType =
  | 'animal-trainer'
  | 'banker'
  | 'healer'
  | 'alchemist'
  | 'tailor'
  | 'cobbler'
  | 'blacksmith'
  | 'jeweler'
  | 'mining-tools'
  | 'carpenter'
  | 'graveyard'
  | 'tinker'
  | 'mage'
  | 'bowyer'
  | 'weaponsmith'
  | 'fisherman'
  | 'bard'
  | 'cook'
  | 'architect'
  | 'provisioner';
export interface Landmark {
  name: string;
  city: string;
  facet: number;
  x: number;
  y: number;
}

// The towns of the shard (Regions.xml TownRegion), set at start (useTowns).
let towns: Town[] = [];
export function useTowns(found: Town[]) {
  towns = found;
}
const gap = (at: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }) =>
  Math.max(r.x - at.x, at.x - (r.x + r.width - 1), r.y - at.y, at.y - (r.y + r.height - 1), 0);

// The town a resident is in, else the nearest within 250 tiles (by its region), else its home town:
// shops, banks and shelter come from where it is, not from where it was born.
export function townAt(at: { x: number; y: number }, home: string): string {
  let best = home;
  let nearest = 250;
  for (const town of towns)
    for (const rect of town.rects) {
      const d = gap(at, rect);
      if (d < nearest) {
        nearest = d;
        best = town.name;
      }
    }
  return best;
}

// Where services are found, from the shard's spawners at start (useShardVendors): each NPC that gives
// one (shops.ts) where its spawner stands, in its town; and the graveyards (Graveyards# spawners).
interface Place {
  city: string;
  name: string;
  x: number;
  y: number;
  z: number;
  kinds: readonly string[];
}
const places = new Map<string, Place[]>();
const key = (city: string, service: ServiceType) => `${city.toLowerCase()}:${service}`;
const STAYS_WITHIN = 12;
export function useShardVendors(spawners: Spawner[]) {
  places.clear();
  for (const spawner of spawners) {
    if (spawner.map !== 'Trammel') continue;
    // An NPC is found where its spawner keeps it; one that roams a wide area (a wandering healer
    // among the wildlife) is met on the way, not sought at the spawner.
    const stays = spawner.range <= STAYS_WITHIN;
    const services = new Set<ServiceType>(stays ? spawner.kinds.flatMap((type) => servicesOf(type)) : []);
    if (spawner.name.startsWith('Graveyards#')) services.add('graveyard');
    const city = services.size ? townAt(spawner, '') : '';
    if (!city) continue;
    const place = { city, name: spawner.name, x: spawner.x, y: spawner.y, z: spawner.z, kinds: spawner.kinds };
    for (const service of services) places.set(key(city, service), [...(places.get(key(city, service)) ?? []), place]);
  }
}
// Every spawner of a town, by its kinds: for what no service names (an inn, a tavern).
const townSpawners: Place[] = [];
export function useTownSpawners(spawners: Spawner[]) {
  townSpawners.splice(
    0,
    townSpawners.length,
    ...spawners.flatMap((s) => {
      const city = s.map === 'Trammel' ? townAt(s, '') : '';
      return city ? [{ city, name: s.name, x: s.x, y: s.y, z: s.z, kinds: s.kinds }] : [];
    })
  );
}

const landmark = (place: Place): Landmark => ({ name: place.name, city: place.city, facet: 1, x: place.x, y: place.y });
export function serviceLocations(city: string, service: ServiceType): readonly Landmark[] {
  return (places.get(key(city, service)) ?? []).map(landmark);
}
// Where a vendor of a service stands in a town (its spawner, with the height it stands at).
export function vendorLocations(city: string, service: ServiceType): readonly { x: number; y: number; z: number }[] {
  return (places.get(key(city, service)) ?? []).map(({ x, y, z }) => ({ x, y, z }));
}

// Public forges, spinning wheels and looms from the shard's decoration data (decoration.ts), read at
// start, by their town: a town without a forge of its own, like Cove or Yew, smelts at the nearest
// one, crossing by gate.
type Station = { city: string; x: number; y: number; z: number; graphic: number };
export const forgeSites: Station[] = [];
export const wheelSites: Station[] = [];
export const loomSites: Station[] = [];
const wheels = graphicsOfKinds('ISpinningWheel');
const looms = graphicsOfKinds('ILoom');
export function useShardForges(placements: Placement[]) {
  const sites = (is: (graphic: number) => boolean) =>
    placements.flatMap((p) => {
      const city = is(p.graphic) ? townAt(p, '') : '';
      return city ? [Object.freeze({ city, x: p.x, y: p.y, z: p.z, graphic: p.graphic })] : [];
    });
  forgeSites.splice(0, forgeSites.length, ...sites(isForge));
  wheelSites.splice(0, wheelSites.length, ...sites((g) => wheels.has(g)));
  loomSites.splice(0, loomSites.length, ...sites((g) => looms.has(g)));
}

// Every place of one service, across all towns.
export function allServiceLocations(service: ServiceType): Landmark[] {
  return [...places].flatMap(([k, list]) => (k.endsWith(`:${service}`) ? list.map(landmark) : []));
}

// Where to go for a service: any of the town's places of that kind, at random, so residents do
// not all walk to the same spot (the nearer ones more often when a starting point is given).
export function pickLocation(
  city: string,
  service: ServiceType,
  from?: { x: number; y: number }
): Landmark | undefined {
  const all = serviceLocations(city, service);
  // A place that just failed from here (no route, or monsters in the way) gives way to another.
  const open = from ? all.filter((point) => reachableFrom(point, from) && withinReach(from, point)) : all;
  const points = open.length ? open : all;
  if (points.length < 2) return points[0];
  const score = (point: Landmark) =>
    (from ? Math.max(Math.abs(point.x - from.x), Math.abs(point.y - from.y)) : 0) + Math.random() * 60;
  return [...points].sort((a, b) => score(a) - score(b))[0];
}

export function serviceLocation(city: string, service: ServiceType): Landmark {
  const point = serviceLocations(city, service)[0];
  if (!point) throw new Error(`No ${service} place in ${city}`);
  return point;
}

// A town's spawners whose kinds match `pattern` (innkeepers and tavern keepers for a resident's leisure).
export const cityLandmarks = (city: string, pattern: RegExp): { name: string; x: number; y: number }[] =>
  townSpawners
    .filter((p) => p.city.toLowerCase() === city.toLowerCase() && p.kinds.some((kind) => pattern.test(kind)))
    .map(({ name, x, y }) => ({ name, x, y }));
